import { mkdir, readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, parse, relative, resolve, sep, basename, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { processPdf } from "./pdf.js";
import { renderMarkdown, type ParsedDocument, type Section } from "./processor.js";

type PdfProcessor = (filePath: string) => Promise<ParsedDocument>;

interface AllowedPath {
  absolutePath: string;
  root: string;
}

interface CachedDocument {
  modifiedAt: number;
  size: number;
  document: ParsedDocument;
}

interface SectionSummary {
  number?: string;
  title: string;
  page?: number;
  children?: SectionSummary[];
}

interface FlatSectionEntry {
  path: number[];
  section: Section;
}

type RootSource = "environment" | "current-directory" | "registered" | "explicit";

interface RootConfig {
  roots: string[];
  source: RootSource;
}

interface StoredProject {
  roots: string[];
  updatedAt: string;
}

interface StoredRoots {
  version: 1;
  projects: Record<string, StoredProject>;
}

interface StartupRoots {
  roots: string[];
  source: RootSource;
  projectPath: string;
}

function configFilePath(): string {
  return process.env.DOCS_DECOMPOSER_CONFIG
    ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "docs-decomposer", "roots.json");
}

function normalizeStoredRoots(value: unknown): StoredRoots {
  const empty: StoredRoots = { version: 1, projects: {} };
  if (!value || typeof value !== "object") {
    return empty;
  }
  const projects = (value as { projects?: unknown }).projects;
  if (!projects || typeof projects !== "object") {
    return empty;
  }
  const normalized: Record<string, StoredProject> = {};
  for (const [projectPath, entry] of Object.entries(projects as Record<string, unknown>)) {
    if (!isAbsolute(projectPath) || !entry || typeof entry !== "object") {
      continue;
    }
    const roots = (entry as { roots?: unknown }).roots;
    if (!Array.isArray(roots)) {
      continue;
    }
    const validRoots = roots.filter((root): root is string =>
      typeof root === "string" && isAbsolute(root),
    );
    if (validRoots.length === 0) {
      continue;
    }
    const updatedAt = (entry as { updatedAt?: unknown }).updatedAt;
    normalized[projectPath] = {
      roots: [...new Set(validRoots)],
      updatedAt: typeof updatedAt === "string" ? updatedAt : new Date(0).toISOString(),
    };
  }
  return { version: 1, projects: normalized };
}

async function readStoredRoots(): Promise<StoredRoots> {
  try {
    return normalizeStoredRoots(JSON.parse(await readFile(configFilePath(), "utf8")));
  } catch {
    return { version: 1, projects: {} };
  }
}

async function writeStoredRoots(stored: StoredRoots): Promise<void> {
  const target = configFilePath();
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
  await rename(temporary, target);
}

export async function resolveStartupRoots(
  projectPathOverride?: string,
): Promise<StartupRoots> {
  const projectPath = projectPathOverride
    ? await realpath(resolve(projectPathOverride))
    : await realpath(process.cwd()).catch(() => resolve(process.cwd()));

  const config = getRootConfigFromEnvironment();
  if (config.source === "environment") {
    return { roots: config.roots, source: "environment", projectPath };
  }

  const stored = await readStoredRoots();
  const remembered = stored.projects[projectPath]?.roots;
  if (remembered && remembered.length > 0) {
    return { roots: remembered, source: "registered", projectPath };
  }
  return { roots: config.roots, source: "current-directory", projectPath };
}

const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_SECTIONS = 100;
const DEFAULT_MAX_CHARS = 20_000;
const MAX_LISTED_PDFS = 500;
const PDF_RESOURCE_PREFIX = "docs-decomposer://pdf/";

const documentPathSchema = z.string().min(1).describe(
  "PDF path. Absolute, or relative to an allowed document root.",
);

interface PromptDefinition {
  name: string;
  description: string;
  arguments: Array<{ name: string; description: string; required: boolean }>;
}

const PROMPTS: PromptDefinition[] = [
  {
    name: "document-overview",
    description: "Walk through a PDF's structure and produce a guided overview.",
    arguments: [
      { name: "path", description: "PDF path within an allowed document root.", required: true },
    ],
  },
  {
    name: "find-topic",
    description: "Locate sections about a topic, read them, and synthesize an answer.",
    arguments: [
      { name: "path", description: "PDF path within an allowed document root.", required: true },
      { name: "topic", description: "Topic or keyword to locate.", required: true },
    ],
  },
  {
    name: "explain-section",
    description: "Read one section and explain it with page references.",
    arguments: [
      { name: "path", description: "PDF path within an allowed document root.", required: true },
      { name: "sectionNumber", description: "Contents number such as 5.2.1.", required: true },
    ],
  },
];

const PROMPT_BUILDERS: Record<string, (args: Record<string, string>) => string> = {
  "document-overview": ({ path }) => [
    `Analyze the structure of the PDF at "${path}" with the docs-decomposer tools.`,
    "1. Call analyze_document with maxDepth 2 to get the top-level structure.",
    "2. If hasMore is true, page through the outline with maxSections and offset.",
    "3. For notable branches, call analyze_document with parentSectionNumber to inspect deeper levels.",
    "4. Produce a short guided overview: the major parts, what each covers, and which section numbers to read next.",
    "Do not call export_markdown; it returns the entire document.",
  ].join("\n"),
  "find-topic": ({ path, topic }) => [
    `Find and explain "${topic}" in the PDF at "${path}".`,
    `1. Call search_sections with query "${topic}".`,
    "2. Choose the most relevant matches and read them with get_section; when truncated is true, continue with offset/nextOffset.",
    "3. Answer with the key points and cite section numbers and page numbers. Say so if nothing matches.",
  ].join("\n"),
  "explain-section": ({ path, sectionNumber }) => [
    `Explain section ${sectionNumber} of the PDF at "${path}".`,
    `1. Call get_section with sectionNumber "${sectionNumber}".`,
    "2. If truncated is true, continue with offset/nextOffset until the section is fully read.",
    "3. Summarize the section, keep its number and page references, and mention child sections that may be relevant.",
  ].join("\n"),
};

function pdfResourceUri(absolutePath: string): string {
  return `${PDF_RESOURCE_PREFIX}${encodeURIComponent(absolutePath)}`;
}

function pathFromResourceUri(uri: string): string | undefined {
  if (!uri.startsWith(PDF_RESOURCE_PREFIX)) {
    return undefined;
  }
  try {
    return decodeURIComponent(uri.slice(PDF_RESOURCE_PREFIX.length));
  } catch {
    return undefined;
  }
}

async function listPdfFiles(root: string, maxFiles = MAX_LISTED_PDFS): Promise<string[]> {
  const pdfPaths: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    if (pdfPaths.length >= maxFiles) {
      return;
    }
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (pdfPaths.length >= maxFiles) {
        return;
      }
      if (entry.isSymbolicLink()) {
        continue;
      }
      const entryPath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".")) {
          await walk(entryPath);
        }
      } else if (entry.isFile() && extname(entry.name).toLowerCase() === ".pdf") {
        pdfPaths.push(entryPath);
      }
    }
  };
  await walk(root);
  return pdfPaths;
}

function renderOutlineMarkdown(document: ParsedDocument, title: string): string {
  const lines: string[] = [
    `# ${title}${document.pageCount ? ` (${document.pageCount} pages)` : ""}`,
    "",
  ];
  const sectionCount = countSections(document.sections);
  if (sectionCount > DEFAULT_MAX_SECTIONS) {
    lines.push(
      `> This outline has ${sectionCount} sections. Use analyze_document with maxSections/offset for paged views, or search_sections to locate a topic.`,
      "",
    );
  }
  const appendSections = (sections: Section[], depth: number): void => {
    for (const section of sections) {
      const label = section.number ? `${section.number} ${section.title}` : section.title;
      const page = section.page ? ` (p.${section.page})` : "";
      lines.push(`${"  ".repeat(depth)}- ${label}${page}`);
      appendSections(section.children, depth + 1);
    }
  };
  appendSections(document.sections, 0);
  return lines.join("\n");
}

function isWithinRoot(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (
    pathFromRoot !== ".." &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRoot)
  );
}

async function canonicalizeRoots(roots: string[]): Promise<string[]> {
  if (roots.length === 0) {
    throw new Error("At least one allowed document root is required.");
  }

  const canonicalRoots = await Promise.all(roots.map(async (root) => {
    const canonicalRoot = await realpath(resolve(root));
    if (!(await stat(canonicalRoot)).isDirectory()) {
      throw new Error("Every allowed document root must be a directory.");
    }
    if (canonicalRoot === parse(canonicalRoot).root) {
      throw new Error("Refusing to use the filesystem root as an allowed document root.");
    }
    return canonicalRoot;
  }));
  return [...new Set(canonicalRoots)];
}

async function resolveAllowedPath(inputPath: string, roots: string[]): Promise<AllowedPath> {
  for (const root of roots) {
    const candidate = isAbsolute(inputPath) ? resolve(inputPath) : resolve(root, inputPath);
    if (!isWithinRoot(root, candidate)) {
      continue;
    }

    let canonicalPath: string;
    try {
      canonicalPath = await realpath(candidate);
    } catch {
      continue;
    }
    if (!isWithinRoot(root, canonicalPath)) {
      throw new Error("The requested path resolves outside the allowed document roots.");
    }
    return { absolutePath: canonicalPath, root };
  }
  throw new Error("The requested path is unavailable or outside the allowed document roots.");
}

function flattenSections(sections: Section[]): Section[] {
  return sections.flatMap((section) => [section, ...flattenSections(section.children)]);
}

function flattenToDepth(
  sections: Section[],
  maxDepth: number,
  depth = 1,
  prefix: number[] = [],
): FlatSectionEntry[] {
  const entries: FlatSectionEntry[] = [];
  sections.forEach((section, index) => {
    const path = [...prefix, index];
    entries.push({ path, section });
    if (depth < maxDepth) {
      entries.push(...flattenToDepth(section.children, maxDepth, depth + 1, path));
    }
  });
  return entries;
}

function toSummary({ number, title, page }: Section): SectionSummary {
  return {
    ...(number ? { number } : {}),
    title,
    ...(page ? { page } : {}),
  };
}

function rebuildSectionTree(entries: FlatSectionEntry[]): SectionSummary[] {
  const roots: SectionSummary[] = [];
  const byPath = new Map<string, SectionSummary>();
  for (const { path, section } of entries) {
    const summary = toSummary(section);
    byPath.set(path.join("."), summary);
    const parent = path.length > 1 ? byPath.get(path.slice(0, -1).join(".")) : undefined;
    if (parent) {
      (parent.children ??= []).push(summary);
    } else {
      roots.push(summary);
    }
  }
  return roots;
}

function countSections(sections: Section[]): number {
  return sections.reduce((count, section) => count + 1 + countSections(section.children), 0);
}

function countSectionsByDepth(sections: Section[], depth = 1): Record<string, number> {
  const childCounts = sections.map((section) => countSectionsByDepth(section.children, depth + 1));
  const counts: Record<string, number> = sections.length > 0 ? { [depth]: sections.length } : {};
  for (const childCount of childCounts) {
    for (const [childDepth, count] of Object.entries(childCount)) {
      counts[childDepth] = (counts[childDepth] ?? 0) + count;
    }
  }
  return counts;
}

function jsonResult(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function errorResult(error: unknown) {
  return {
    content: [{
      type: "text" as const,
      text: error instanceof Error ? error.message : "The requested operation failed.",
    }],
    isError: true,
  };
}

export function getRootConfigFromEnvironment(): RootConfig {
  const configuredRoots = process.env.DOCS_DECOMPOSER_ROOTS;
  const roots = configuredRoots
    ? configuredRoots.split(delimiter).map((root) => root.trim()).filter(Boolean)
    : [];
  if (roots.length > 0) {
    return { roots, source: "environment" };
  }
  return { roots: [process.cwd()], source: "current-directory" };
}

export function getAllowedRootsFromEnvironment(): string[] {
  return getRootConfigFromEnvironment().roots;
}

export async function createMcpServer(
  allowedRootPaths?: string[],
  pdfProcessor: PdfProcessor = processPdf,
  debugEnabled = process.env.DEBUG === "1",
  rootSource?: RootSource,
): Promise<McpServer> {
  const startup = allowedRootPaths === undefined
    ? await resolveStartupRoots()
    : {
        roots: allowedRootPaths,
        source: rootSource ?? "explicit",
        projectPath: await realpath(process.cwd()).catch(() => resolve(process.cwd())),
      };
  const resolvedRootSource = startup.source;
  const projectPath = startup.projectPath;
  let roots = await canonicalizeRoots(startup.roots);
  const server = new McpServer(
    { name: "docs-decomposer", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );
  server.server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const resources = [];
    for (const root of roots) {
      for (const pdfPath of await listPdfFiles(root)) {
        const relativePath = relative(root, pdfPath).split(sep).join("/");
        resources.push({
          uri: pdfResourceUri(pdfPath),
          name: basename(pdfPath),
          title: relativePath,
          mimeType: "application/pdf",
        });
      }
    }
    return { resources };
  });
  server.server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [{
      uriTemplate: `${PDF_RESOURCE_PREFIX}{path}`,
      name: "PDF document outline",
      description: "A PDF inside an allowed document root. Reading it returns the section outline as Markdown.",
      mimeType: "text/markdown",
    }],
  }));
  server.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const requestedPath = pathFromResourceUri(request.params.uri);
    if (!requestedPath) {
      throw new Error(`Unsupported resource URI: ${request.params.uri}`);
    }
    const { path: canonicalPath, document } = await loadDocument(requestedPath);
    const title = document.preamble.split("\n")[0] || basename(canonicalPath);
    return {
      contents: [{
        uri: request.params.uri,
        mimeType: "text/markdown",
        text: renderOutlineMarkdown(document, title),
      }],
    };
  });
  server.server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: PROMPTS }));
  server.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: promptArguments } = request.params;
    const definition = PROMPTS.find((prompt) => prompt.name === name);
    const builder = PROMPT_BUILDERS[name];
    if (!definition || !builder) {
      throw new Error(`Unknown prompt: ${name}`);
    }
    const missingArgument = definition.arguments.find((argument) =>
      argument.required && !promptArguments?.[argument.name],
    );
    if (missingArgument) {
      throw new Error(`Missing required prompt argument: ${missingArgument.name}`);
    }
    const resolvedArguments = Object.fromEntries(
      definition.arguments.map((argument) => [argument.name, promptArguments?.[argument.name] ?? ""]),
    );
    return {
      description: definition.description,
      messages: [{
        role: "user" as const,
        content: { type: "text" as const, text: builder(resolvedArguments) },
      }],
    };
  });
  const documentCache = new Map<string, CachedDocument>();

  const loadDocument = async (
    inputPath: string,
  ): Promise<{ path: string; root: string; document: ParsedDocument }> => {
    const resolvedPath = await resolveAllowedPath(inputPath, roots);
    if (extname(resolvedPath.absolutePath).toLowerCase() !== ".pdf") {
      throw new Error("Only PDF documents are supported.");
    }

    const fileInfo = await stat(resolvedPath.absolutePath);
    if (!fileInfo.isFile()) {
      throw new Error("The requested PDF path is not a file.");
    }

    const cached = documentCache.get(resolvedPath.absolutePath);
    let document = cached?.modifiedAt === fileInfo.mtimeMs && cached.size === fileInfo.size
      ? cached.document
      : undefined;
    if (!document) {
      document = await pdfProcessor(resolvedPath.absolutePath);
      documentCache.delete(resolvedPath.absolutePath);
      documentCache.set(resolvedPath.absolutePath, {
        modifiedAt: fileInfo.mtimeMs,
        size: fileInfo.size,
        document,
      });
      if (documentCache.size > 4) {
        const oldestPath = documentCache.keys().next().value;
        if (oldestPath) {
          documentCache.delete(oldestPath);
        }
      }
    } else {
      documentCache.delete(resolvedPath.absolutePath);
      if (cached) {
        documentCache.set(resolvedPath.absolutePath, cached);
      }
    }
    return { path: resolvedPath.absolutePath, root: resolvedPath.root, document };
  };

  server.registerTool(
    "list_roots",
    {
      description: "List the document directories this server is allowed to access.",
      inputSchema: {},
    },
    async () => jsonResult({
      roots,
      rootDetails: roots.map((root) => ({ path: root, source: resolvedRootSource })),
      projectPath,
      configPath: configFilePath(),
    }),
  );

  server.registerTool(
    "register_root",
    {
      description: "Remember a document directory for a project so later sessions use it automatically. The directory must be inside the project directory. Call list_roots first to see the current project path and roots.",
      inputSchema: {
        path: z.string().min(1).describe("Document directory, absolute or relative to projectPath."),
        projectPath: z.string().min(1).optional().describe("Project directory. Defaults to the server working directory."),
      },
    },
    async ({ path: inputPath, projectPath: inputProjectPath }) => {
      try {
        const canonicalProject = await realpath(resolve(inputProjectPath ?? projectPath));
        if (!(await stat(canonicalProject)).isDirectory()) {
          throw new Error("The project path must be a directory.");
        }

        const candidate = isAbsolute(inputPath)
          ? resolve(inputPath)
          : resolve(canonicalProject, inputPath);
        let canonicalRoot: string;
        try {
          canonicalRoot = await realpath(candidate);
        } catch {
          throw new Error("The document directory does not exist.");
        }
        if (!(await stat(canonicalRoot)).isDirectory()) {
          throw new Error("The document directory must be a directory.");
        }
        if (!isWithinRoot(canonicalProject, canonicalRoot)) {
          throw new Error("The document directory must be inside the project directory.");
        }
        if (canonicalRoot === parse(canonicalRoot).root) {
          throw new Error("Refusing to use the filesystem root as an allowed document root.");
        }

        const stored = await readStoredRoots();
        const existingRoots = stored.projects[canonicalProject]?.roots ?? [];
        const projectRoots = [...new Set([...existingRoots, canonicalRoot])];
        stored.projects[canonicalProject] = {
          roots: projectRoots,
          updatedAt: new Date().toISOString(),
        };
        await writeStoredRoots(stored);
        roots = await canonicalizeRoots([...roots, ...projectRoots]);

        return jsonResult({
          projectPath: canonicalProject,
          roots: projectRoots,
          configPath: configFilePath(),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "list_directory",
    {
      description: "List PDF files and subdirectories inside an allowed document root.",
      inputSchema: {
        path: z.string().optional().describe(
          "Directory path. Absolute, or relative to an allowed document root. Omit to list the allowed roots.",
        ),
      },
    },
    async ({ path }) => {
      try {
        if (!path) {
          return jsonResult({
            entries: roots.map((root) => ({ name: basename(root), path: root, type: "directory" })),
          });
        }

        const resolvedPath = await resolveAllowedPath(path, roots);
        if (!(await stat(resolvedPath.absolutePath)).isDirectory()) {
          throw new Error("The requested path is not a directory.");
        }
        const entries = await readdir(resolvedPath.absolutePath, { withFileTypes: true });
        const visibleEntries = entries
          .filter((entry) => !entry.isSymbolicLink())
          .filter((entry) => entry.isDirectory() || (entry.isFile() && extname(entry.name).toLowerCase() === ".pdf"))
          .map((entry) => ({
            name: entry.name,
            path: relative(resolvedPath.root, resolve(resolvedPath.absolutePath, entry.name)).split(sep).join("/"),
            type: entry.isDirectory() ? "directory" : "pdf",
          }))
          .sort((left, right) => left.type.localeCompare(right.type) || left.name.localeCompare(right.name));
        return jsonResult({ entries: visibleEntries });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "analyze_document",
    {
      description: "Analyze a PDF and return a depth-limited table-of-contents tree without section bodies. The path may be absolute or relative to an allowed document root. Use parentSectionNumber to scope to a branch, maxDepth for depth, and maxSections/offset to page through long outlines.",
      inputSchema: {
        path: documentPathSchema,
        parentSectionNumber: z.string().min(1).optional(),
        maxDepth: z.number().int().min(1).max(6).default(DEFAULT_MAX_DEPTH),
        maxSections: z.number().int().min(1).max(1000).default(DEFAULT_MAX_SECTIONS),
        offset: z.number().int().min(0).default(0),
      },
    },
    async ({ path, parentSectionNumber, maxDepth, maxSections, offset }) => {
      try {
        const { path: canonicalPath, root: allowedRoot, document } = await loadDocument(path);
        const parentSection = parentSectionNumber
          ? flattenSections(document.sections).find((section) => section.number === parentSectionNumber)
          : undefined;
        if (parentSectionNumber && !parentSection) {
          throw new Error(`Section ${parentSectionNumber} was not found in this document.`);
        }
        const scopedSections = parentSection ? [parentSection] : document.sections;
        const sectionCount = countSections(scopedSections);
        const visibleEntries = flattenToDepth(scopedSections, maxDepth);
        const pageEntries = visibleEntries.slice(offset, offset + maxSections);
        const returnedSectionCount = pageEntries.length;
        const hasMore = offset + returnedSectionCount < visibleEntries.length;
        const omittedSectionCount = sectionCount - returnedSectionCount;
        const result: Record<string, unknown> = {
          path: canonicalPath,
          root: allowedRoot,
          title: document.preamble.split("\n")[0] || basename(canonicalPath),
          pageCount: document.pageCount ?? null,
          sectionCount,
          returnedSectionCount,
          omittedSectionCount,
          omittedByDepth: sectionCount - visibleEntries.length,
          maxDepth,
          maxSections,
          offset,
          truncated: omittedSectionCount > 0,
          hasMore,
          ...(hasMore ? { nextOffset: offset + returnedSectionCount } : {}),
          ...(parentSectionNumber ? { parentSectionNumber } : {}),
          sections: rebuildSectionTree(pageEntries),
        };
        const hints: string[] = [];
        if (hasMore) {
          hints.push(
            `Outline truncated. Continue with offset=${offset + returnedSectionCount} for the next page, or narrow the scope with parentSectionNumber.`,
          );
        }
        if (sectionCount > visibleEntries.length) {
          hints.push(
            `Sections deeper than maxDepth=${maxDepth} were omitted; raise maxDepth or set parentSectionNumber to inspect them.`,
          );
        }
        if (hints.length > 0) {
          result.hint = hints.join(" ");
        }
        if (debugEnabled) {
          result.debug = {
            sectionCountsByDepth: countSectionsByDepth(scopedSections),
            visibleSectionCount: visibleEntries.length,
            returnedSectionCount,
            omittedSectionCount,
            scope: parentSectionNumber ?? "document",
          };
        }
        return jsonResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_section",
    {
      description: "Read one PDF section by its contents number. Long sections are capped by maxChars; use offset to page through the rest.",
      inputSchema: {
        path: documentPathSchema,
        sectionNumber: z.string().min(1),
        maxChars: z.number().int().min(1).max(200_000).default(DEFAULT_MAX_CHARS),
        offset: z.number().int().min(0).default(0),
      },
    },
    async ({ path, sectionNumber, maxChars, offset }) => {
      try {
        const { path: canonicalPath, root: allowedRoot, document } = await loadDocument(path);
        const section = flattenSections(document.sections).find((item) => item.number === sectionNumber);
        if (!section) {
          throw new Error(`Section ${sectionNumber} was not found in this document.`);
        }
        const contentOffset = Math.min(offset, section.content.length);
        const content = section.content.slice(contentOffset, contentOffset + maxChars);
        const hasMoreContent = contentOffset + content.length < section.content.length;
        return jsonResult({
          path: canonicalPath,
          root: allowedRoot,
          pageCount: document.pageCount ?? null,
          ...(section.number ? { number: section.number } : {}),
          title: section.title,
          page: section.page ?? null,
          content,
          contentOffset,
          totalChars: section.content.length,
          truncated: hasMoreContent,
          ...(hasMoreContent
            ? {
                nextOffset: contentOffset + content.length,
                hint: `Section content truncated at ${content.length} of ${section.content.length} characters. Continue with offset=${contentOffset + content.length}.`,
              }
            : {}),
          childSections: section.children.map((child) => ({
            ...(child.number ? { number: child.number } : {}),
            title: child.title,
            page: child.page ?? null,
          })),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "search_sections",
    {
      description: "Search section titles and numbers without returning section bodies. Use this to locate sections before calling get_section.",
      inputSchema: {
        path: documentPathSchema,
        query: z.string().min(1),
        maxResults: z.number().int().min(1).max(100).default(20),
      },
    },
    async ({ path, query, maxResults }) => {
      try {
        const { path: canonicalPath, root: allowedRoot, document } = await loadDocument(path);
        const normalizedQuery = query.trim().toLowerCase();
        const matches = flattenSections(document.sections).filter((section) => {
          if (section.title.toLowerCase().includes(normalizedQuery)) {
            return true;
          }
          if (!section.number) {
            return false;
          }
          return section.number === normalizedQuery
            || section.number.startsWith(`${normalizedQuery}.`);
        });
        const returnedMatches = matches.slice(0, maxResults);
        const result: Record<string, unknown> = {
          path: canonicalPath,
          root: allowedRoot,
          pageCount: document.pageCount ?? null,
          query,
          matchCount: matches.length,
          returnedCount: returnedMatches.length,
          truncated: matches.length > returnedMatches.length,
          matches: returnedMatches.map((section) => ({
            ...(section.number ? { number: section.number } : {}),
            title: section.title,
            page: section.page ?? null,
            level: section.level,
          })),
        };
        const hints: string[] = [];
        if (result.truncated) {
          hints.push(
            `Only the first ${returnedMatches.length} matches are shown. Narrow the query or raise maxResults to see more.`,
          );
        }
        if (matches.length === 0) {
          hints.push("No section titles matched. Try a shorter keyword or a section number prefix.");
        }
        if (hints.length > 0) {
          result.hint = hints.join(" ");
        }
        return jsonResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "export_markdown",
    {
      description: "Convert the complete PDF document to Markdown text.",
      inputSchema: { path: z.string().min(1) },
    },
    async ({ path }) => {
      try {
        const { path: canonicalPath, root: allowedRoot, document } = await loadDocument(path);
        return {
          content: [{ type: "text" as const, text: renderMarkdown(document) }],
          structuredContent: { path: canonicalPath, root: allowedRoot, format: "markdown" },
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
}

export async function runMcpServer(): Promise<void> {
  const startup = await resolveStartupRoots();
  const server = await createMcpServer(
    startup.roots,
    processPdf,
    process.env.DEBUG === "1",
    startup.source,
  );
  console.error(
    `docs-decomposer: allowed roots: ${startup.roots.join(", ")} (source: ${startup.source})`,
  );
  if (startup.source === "current-directory") {
    console.error(
      "docs-decomposer: no registered roots for this project and DOCS_DECOMPOSER_ROOTS is not set; using the current working directory. Call the register_root tool to remember a document directory.",
    );
  }
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runMcpServer().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Failed to start MCP server.");
    process.exitCode = 1;
  });
}