import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import test from "node:test";
import { createMcpServer, resolveStartupRoots } from "../src/mcp-server.js";
import type { ParsedDocument } from "../src/processor.js";

const sampleDocument: ParsedDocument = {
  preamble: "Sample document",
  pageCount: 5,
  sections: [
    {
      id: "1-overview",
      number: "1",
      title: "Overview",
      level: 1,
      page: 2,
      content: "Overview body",
      children: [
        {
          id: "1-1-details",
          number: "1.1",
          title: "Details",
          level: 2,
          page: 3,
          content: "Details body",
          children: [
            {
              id: "1-1-1-advanced",
              number: "1.1.1",
              title: "Advanced",
              level: 3,
              page: 4,
              content: "Advanced body",
              children: [
                {
                  id: "1-1-1-1-internals",
                  number: "1.1.1.1",
                  title: "Internals",
                  level: 4,
                  page: 5,
                  content: "Internals body",
                  children: [],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

async function connectMcpClient(server: Awaited<ReturnType<typeof createMcpServer>>) {
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

function readStructuredResult(result: unknown) {
  assert.ok(result && typeof result === "object");
  const structuredContent = (result as { structuredContent?: unknown }).structuredContent;
  assert.ok(structuredContent && typeof structuredContent === "object");
  return structuredContent as Record<string, unknown>;
}

function readTextContent(result: unknown): string {
  assert.ok(result && typeof result === "object");
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content));
  const firstItem = content[0] as { type?: string; text?: string } | undefined;
  assert.equal(firstItem?.type, "text");
  return firstItem?.text ?? "";
}

function readJsonText(result: unknown): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readTextContent(result));
  assert.ok(parsed && typeof parsed === "object");
  return parsed as Record<string, unknown>;
}

test("registers document browsing and section tools over MCP", async () => {
  const root = await mkdtemp(join(tmpdir(), "docs-decomposer-mcp-"));
  const canonicalRoot = await realpath(root);
  await mkdir(join(root, "manuals"));
  await writeFile(join(root, "manuals", "guide.pdf"), "%PDF-1.7");
  const server = await createMcpServer([root], async () => sampleDocument, false);
  const client = await connectMcpClient(server);

  try {
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      ["analyze_document", "export_markdown", "get_section", "list_directory", "list_roots", "register_root", "search_sections"],
    );
    const capabilities = client.getServerCapabilities() ?? {};
    assert.equal("tools" in capabilities, true);
    assert.equal("resources" in capabilities, true);
    assert.equal("prompts" in capabilities, true);

    const roots = readStructuredResult(await client.callTool({ name: "list_roots", arguments: {} }));
    assert.deepEqual(roots.roots, [canonicalRoot]);
    assert.deepEqual(roots.rootDetails, [{ path: canonicalRoot, source: "explicit" }]);
    const listedResources = await client.listResources();
    assert.equal(listedResources.resources.length, 1);
    const pdfResource = listedResources.resources[0];
    assert.ok(pdfResource);
    assert.equal(pdfResource.name, "guide.pdf");
    assert.equal(pdfResource.title, "manuals/guide.pdf");
    assert.equal(pdfResource.mimeType, "application/pdf");
    assert.match(pdfResource.uri, /^docs-decomposer:\/\/pdf\//);

    const templates = await client.listResourceTemplates();
    assert.deepEqual(templates.resourceTemplates.map((template) => template.uriTemplate), [
      "docs-decomposer://pdf/{path}",
    ]);

    const resourceContent = await client.readResource({ uri: pdfResource.uri });
    const outline = resourceContent.contents[0] as { mimeType?: string; text?: string } | undefined;
    assert.equal(outline?.mimeType, "text/markdown");
    assert.match(outline?.text ?? "", /^# Sample document \(5 pages\)$/m);
    assert.match(outline?.text ?? "", /^- 1 Overview \(p\.2\)$/m);
    assert.match(outline?.text ?? "", /^  - 1\.1 Details \(p\.3\)$/m);

    const prompts = await client.listPrompts();
    assert.deepEqual(
      prompts.prompts.map((prompt) => prompt.name).sort(),
      ["document-overview", "explain-section", "find-topic"],
    );

    const topicPrompt = await client.getPrompt({
      name: "find-topic",
      arguments: { path: "manuals/guide.pdf", topic: "details" },
    });
    assert.equal(topicPrompt.messages.length, 1);
    const promptMessage = topicPrompt.messages[0];
    assert.equal(promptMessage?.role, "user");
    const promptContent = promptMessage?.content as { type?: string; text?: string } | undefined;
    assert.equal(promptContent?.type, "text");
    assert.match(promptContent?.text ?? "", /manuals\/guide\.pdf/);
    assert.match(promptContent?.text ?? "", /"details"/);
    assert.match(promptContent?.text ?? "", /search_sections/);

    await assert.rejects(
      client.getPrompt({ name: "find-topic", arguments: { path: "manuals/guide.pdf" } }),
      /Missing required prompt argument: topic/,
    );

    const listingResult = await client.callTool({
      name: "list_directory",
      arguments: { path: "manuals" },
    });
    const listing = readStructuredResult(listingResult);
    assert.deepEqual(readJsonText(listingResult), listing);
    assert.deepEqual(listing.entries, [
      { name: "guide.pdf", path: "manuals/guide.pdf", type: "pdf" },
    ]);

    const analysisResult = await client.callTool({
      name: "analyze_document",
      arguments: { path: "manuals/guide.pdf" },
    });
    const analysis = readStructuredResult(analysisResult);
    assert.equal(readJsonText(analysisResult).returnedSectionCount, 3);
    assert.equal(analysis.root, canonicalRoot);
    assert.equal(analysis.pageCount, 5);
    assert.equal(analysis.sectionCount, 4);
    assert.equal(analysis.returnedSectionCount, 3);
    assert.equal(analysis.omittedSectionCount, 1);
    assert.equal(analysis.maxDepth, 3);
    assert.equal(analysis.truncated, true);
    assert.match(String(analysis.hint), /maxDepth=3/);
    assert.equal("debug" in analysis, false);
    const topSections = analysis.sections as Array<Record<string, unknown>>;
    const topSection = topSections[0] ?? {};
    assert.equal("id" in topSection, false);
    assert.equal("level" in topSection, false);
    const nestedSection = topSection.children as Array<Record<string, unknown>>;
    const levelThree = nestedSection[0]?.children as Array<Record<string, unknown>>;
    const deepest = levelThree[0];
    assert.ok(deepest);
    assert.equal("children" in deepest, false);

    const pagedAnalysis = readStructuredResult(await client.callTool({
      name: "analyze_document",
      arguments: { path: "manuals/guide.pdf", maxSections: 2 },
    }));
    assert.equal(pagedAnalysis.returnedSectionCount, 2);
    assert.equal(pagedAnalysis.hasMore, true);
    assert.equal(pagedAnalysis.nextOffset, 2);
    assert.match(String(pagedAnalysis.hint), /offset=2/);
    const nextPage = readStructuredResult(await client.callTool({
      name: "analyze_document",
      arguments: { path: "manuals/guide.pdf", maxSections: 2, offset: 2 },
    }));
    assert.equal(nextPage.returnedSectionCount, 1);
    assert.equal(nextPage.hasMore, false);
    assert.equal(nextPage.offset, 2);

    const search = readStructuredResult(await client.callTool({
      name: "search_sections",
      arguments: { path: "manuals/guide.pdf", query: "detail" },
    }));
    assert.equal(search.matchCount, 1);
    assert.deepEqual(search.matches, [
      { number: "1.1", title: "Details", page: 3, level: 2 },
    ]);

    const numberSearch = readStructuredResult(await client.callTool({
      name: "search_sections",
      arguments: { path: "manuals/guide.pdf", query: "1.1" },
    }));
    assert.equal(numberSearch.matchCount, 3);

    const emptySearch = readStructuredResult(await client.callTool({
      name: "search_sections",
      arguments: { path: "manuals/guide.pdf", query: "zzz-not-found" },
    }));
    assert.equal(emptySearch.matchCount, 0);
    assert.match(String(emptySearch.hint), /No section titles matched/);

    const scopedAnalysis = readStructuredResult(await client.callTool({
      name: "analyze_document",
      arguments: { path: "manuals/guide.pdf", parentSectionNumber: "1.1", maxDepth: 2 },
    }));
    assert.equal(scopedAnalysis.sectionCount, 3);
    assert.equal(scopedAnalysis.returnedSectionCount, 2);
    assert.equal(scopedAnalysis.omittedSectionCount, 1);
    assert.equal(scopedAnalysis.parentSectionNumber, "1.1");

    const expandedAnalysis = readStructuredResult(await client.callTool({
      name: "analyze_document",
      arguments: { path: "manuals/guide.pdf", parentSectionNumber: "1.1", maxDepth: 3 },
    }));
    assert.equal(expandedAnalysis.omittedSectionCount, 0);

    const section = readStructuredResult(await client.callTool({
      name: "get_section",
      arguments: { path: "manuals/guide.pdf", sectionNumber: "1.1" },
    }));
    assert.equal(section.content, "Details body");
    assert.equal(section.truncated, false);
    assert.equal(section.totalChars, "Details body".length);

    const truncatedSection = readStructuredResult(await client.callTool({
      name: "get_section",
      arguments: { path: "manuals/guide.pdf", sectionNumber: "1.1", maxChars: 5 },
    }));
    assert.equal(truncatedSection.content, "Detai");
    assert.equal(truncatedSection.truncated, true);
    assert.equal(truncatedSection.nextOffset, 5);
    assert.match(String(truncatedSection.hint), /offset=5/);

    const sectionTail = readStructuredResult(await client.callTool({
      name: "get_section",
      arguments: { path: "manuals/guide.pdf", sectionNumber: "1.1", maxChars: 20, offset: 5 },
    }));
    assert.equal(sectionTail.content, "ls body");
    assert.equal(sectionTail.truncated, false);

    const markdown = await client.callTool({
      name: "export_markdown",
      arguments: { path: "manuals/guide.pdf" },
    });
    const markdownData = readStructuredResult(markdown);
    assert.equal(markdownData.format, "markdown");
    assert.match(readTextContent(markdown), /^Sample document/m);
    const content = (markdown as { content: Array<{ type: string; text?: string }> }).content;
    assert.match(content[0]?.type === "text" ? content[0].text ?? "" : "", /## 1\.1 Details/);
  } finally {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }

});

test("pages through very long section content over MCP without losing text", async () => {
  const root = await mkdtemp(join(tmpdir(), "docs-decomposer-mcp-long-section-"));
  await mkdir(join(root, "manuals"));
  await writeFile(join(root, "manuals", "guide.pdf"), "%PDF-1.7");

  const overview = sampleDocument.sections[0];
  assert.ok(overview);
  const details = overview.children[0];
  assert.ok(details);

  const longContent = Array.from({ length: 45_321 }, (_, index) =>
    String.fromCharCode(65 + (index % 26))).join("");
  const longDocument: ParsedDocument = {
    ...sampleDocument,
    sections: [{
      ...overview,
      children: [{ ...details, content: longContent }],
    }],
  };
  const server = await createMcpServer([root], async () => longDocument, false);
  const client = await connectMcpClient(server);

  try {
    const chunks: string[] = [];
    let offset = 0;
    while (true) {
      const result = readStructuredResult(await client.callTool({
        name: "get_section",
        arguments: { path: "manuals/guide.pdf", sectionNumber: "1.1", maxChars: 20_000, offset },
      }));
      const content = String(result.content);
      chunks.push(content);
      assert.equal(result.contentOffset, offset);
      assert.equal(result.totalChars, longContent.length);

      if (!result.truncated) {
        break;
      }

      const nextOffset = Number(result.nextOffset);
      assert.equal(nextOffset, offset + content.length);
      assert.match(String(result.hint), new RegExp(`${nextOffset} of ${longContent.length}`));
      offset = nextOffset;
    }

    assert.equal(chunks.join(""), longContent);
  } finally {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("adds depth diagnostics when the MCP server starts with DEBUG=1", async () => {
  const root = await mkdtemp(join(tmpdir(), "docs-decomposer-debug-"));
  await writeFile(join(root, "guide.pdf"), "%PDF-1.7");
  const previousDebug = process.env.DEBUG;
  process.env.DEBUG = "1";
  let server;
  try {
    server = await createMcpServer([root], async () => sampleDocument);
  } finally {
    if (previousDebug === undefined) {
      delete process.env.DEBUG;
    } else {
      process.env.DEBUG = previousDebug;
    }
  }
  const client = await connectMcpClient(server);
  try {
    const debugAnalysis = readStructuredResult(await client.callTool({
      name: "analyze_document",
      arguments: { path: "guide.pdf" },
    }));
    const debug = debugAnalysis.debug as Record<string, unknown>;
    assert.deepEqual(debug.sectionCountsByDepth, { "1": 1, "2": 1, "3": 1, "4": 1 });
    assert.equal(debug.omittedSectionCount, 1);
  } finally {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("registers a document root for a project and remembers it", async () => {
  const project = await mkdtemp(join(tmpdir(), "docs-decomposer-project-"));
  const documents = join(project, "documents");
  await mkdir(documents);
  await writeFile(join(documents, "guide.pdf"), "%PDF-1.7");
  const configPath = join(project, "roots.json");

  const previousConfig = process.env.DOCS_DECOMPOSER_CONFIG;
  const previousRoots = process.env.DOCS_DECOMPOSER_ROOTS;
  const previousProject = process.env.DOCS_DECOMPOSER_PROJECT;
  process.env.DOCS_DECOMPOSER_CONFIG = configPath;
  process.env.DOCS_DECOMPOSER_PROJECT = project;
  delete process.env.DOCS_DECOMPOSER_ROOTS;

  const server = await createMcpServer([project], async () => sampleDocument);
  const client = await connectMcpClient(server);
  try {
    const canonicalProject = await realpath(project);
    const canonicalDocuments = await realpath(documents);

    const registered = readStructuredResult(await client.callTool({
      name: "register_root",
      arguments: { path: "documents" },
    }));
    assert.equal(registered.projectPath, canonicalProject);
    assert.deepEqual(registered.roots, [canonicalDocuments]);

    const stored = JSON.parse(await readFile(configPath, "utf8")) as {
      projects: Record<string, { roots: string[] }>;
    };
    assert.deepEqual(stored.projects[canonicalProject]?.roots, [canonicalDocuments]);

    const startup = await resolveStartupRoots(project);
    assert.equal(startup.source, "registered");
    assert.deepEqual(startup.roots, [canonicalDocuments]);

    const rejected = await client.callTool({
      name: "register_root",
      arguments: { path: join(project, "..") },
    });
    assert.equal(rejected.isError, true);

    // A client-supplied projectPath must not widen the containment check.
    const scopedBypass = await client.callTool({
      name: "register_root",
      arguments: { path: join(project, ".."), projectPath: join(project, "..") },
    });
    assert.equal(scopedBypass.isError, true);
  } finally {
    await client.close();
    await server.close();
    await rm(project, { recursive: true, force: true });
    if (previousConfig === undefined) {
      delete process.env.DOCS_DECOMPOSER_CONFIG;
    } else {
      process.env.DOCS_DECOMPOSER_CONFIG = previousConfig;
    }
    if (previousRoots === undefined) {
      delete process.env.DOCS_DECOMPOSER_ROOTS;
    } else {
      process.env.DOCS_DECOMPOSER_ROOTS = previousRoots;
    }
    if (previousProject === undefined) {
      delete process.env.DOCS_DECOMPOSER_PROJECT;
    } else {
      process.env.DOCS_DECOMPOSER_PROJECT = previousProject;
    }
  }
});

test("refuses the filesystem root as an allowed document root", async () => {
  await assert.rejects(
    createMcpServer(["/"]),
    /Refusing to use the filesystem root/,
  );
});

test("warns about long outlines when reading a PDF resource", async () => {
  const root = await mkdtemp(join(tmpdir(), "docs-decomposer-large-"));
  await writeFile(join(root, "large.pdf"), "%PDF-1.7");
  const largeDocument: ParsedDocument = {
    preamble: "Large document",
    pageCount: 10,
    sections: Array.from({ length: 101 }, (_, index) => ({
      id: `section-${index + 1}`,
      number: `${index + 1}`,
      title: `Section ${index + 1}`,
      level: 1,
      page: 1,
      content: "",
      children: [],
    })),
  };
  const server = await createMcpServer([root], async () => largeDocument);
  const client = await connectMcpClient(server);

  try {
    const resources = await client.listResources();
    const resource = resources.resources[0];
    assert.ok(resource);
    const content = await client.readResource({ uri: resource.uri });
    const text = (content.contents[0] as { text?: string } | undefined)?.text ?? "";
    assert.match(text, /This outline has 101 sections/);
    assert.match(text, /analyze_document with maxSections\/offset/);
    assert.match(text, /search_sections to locate a topic/);
  } finally {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects paths outside allowed roots and symlinks that escape them", async () => {
  const root = await mkdtemp(join(tmpdir(), "docs-decomposer-root-"));
  const outside = await mkdtemp(join(tmpdir(), "docs-decomposer-outside-"));
  await writeFile(join(outside, "secret.pdf"), "%PDF-1.7");
  await symlink(join(outside, "secret.pdf"), join(root, "linked.pdf"));
  const server = await createMcpServer([root], async () => sampleDocument);
  const client = await connectMcpClient(server);

  try {
    for (const path of [join(outside, "secret.pdf"), "linked.pdf"]) {
      const result = await client.callTool({
        name: "analyze_document",
        arguments: { path },
      });
      assert.equal(result.isError, true);
      assert.match(readTextContent(result), /outside the allowed document roots/);
    }
  } finally {
    await client.close();
    await server.close();
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  }
});