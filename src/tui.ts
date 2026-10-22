import { readdir, stat } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import blessed from "blessed";

import { processPdf } from "./pdf.js";
import type { Section } from "./processor.js";

export interface SectionRow {
  title: string;
  depth: number;
  page?: number;
  href?: string;
}

export function flattenSectionRows(sections: Section[], depth = 1): SectionRow[] {
  const rows: SectionRow[] = [];

  for (const section of sections) {
    rows.push({
      title: section.title,
      depth,
      page: section.page,
      href: section.link?.href,
    });
    rows.push(...flattenSectionRows(section.children, depth + 1));
  }

  return rows;
}

interface FlatSectionEntry {
  section: Section;
  depth: number;
}

function flattenSectionEntries(sections: Section[], depth = 1): FlatSectionEntry[] {
  const entries: FlatSectionEntry[] = [];

  for (const section of sections) {
    entries.push({ section, depth });
    entries.push(...flattenSectionEntries(section.children, depth + 1));
  }

  return entries;
}

export function paginateSectionPreview(section: Section, linesPerPage = 24): string[] {
  const title = section.number ? `${section.number} ${section.title}` : section.title;
  const metadata = [
    title,
    ...(section.link?.href ? [`Link: ${section.link.href}`] : []),
    ...(section.page ? [`Page: ${section.page}`] : []),
  ].join("\n");
  const lines = section.content.trim().split(/\r?\n/);
  const pageSize = Math.max(1, Math.floor(linesPerPage));
  const chunks = lines.length === 1 && lines[0] === ""
    ? [[]]
    : Array.from({ length: Math.ceil(lines.length / pageSize) }, (_, index) =>
      lines.slice(index * pageSize, (index + 1) * pageSize));

  return chunks.map((chunk, index) =>
    `${metadata}\n\nBody page ${index + 1}/${chunks.length}\n\n${chunk.join("\n")}`);
}

interface PreviewPagingState {
  pages: string[];
  pageIndex: number;
  sectionStatus: string;
}

function renderPreviewPage(preview: any, status: any, screen: any, paging: PreviewPagingState): void {
  const totalPages = paging.pages.length;
  preview.setContent(paging.pages[paging.pageIndex] ?? "");
  preview.scrollTo(0);
  status.setContent(`${paging.sectionStatus}  •  Body ${paging.pageIndex + 1}/${totalPages}`);
  screen.render();
}

export interface DirectoryListingEntry {
  name: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: Date;
}

export function formatDirectoryListing(entries: DirectoryListingEntry[]): string {
  const rows = entries.map((entry) => {
    const type = entry.isDirectory ? "d" : "-";
    const size = entry.isDirectory ? "<DIR>" : String(entry.size).padStart(8, " ");
    const mtime = entry.modifiedAt.toLocaleString("en-CA", {
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).replace(/\s+/g, " ");
    return `${type}rwxr-xr-x  1  ${size}  ${mtime}  ${entry.name}${entry.isDirectory ? "/" : ""}`;
  });

  return rows.join("\n") || "(empty directory)";
}

async function loadPdf(
  list: any,
  preview: any,
  status: any,
  input: any,
  screen: any,
  previewPaging: PreviewPagingState,
  onDirectoryOpen: (nextPath: string) => void,
): Promise<void> {
  const filePath = input.getValue().trim();
  if (!filePath) {
    return;
  }

  const resolved = resolve(filePath);

  try {
    const info = await stat(resolved);
    if (info.isDirectory()) {
      onDirectoryOpen(resolved);
      return;
    }

    if (!resolved.toLowerCase().endsWith(".pdf")) {
      status.setContent(`Not a PDF: ${resolved}`);
      preview.setContent(`Expected a .pdf file but received: ${resolved}`);
      screen.render();
      return;
    }

    const document = await processPdf(resolved);
    const flatSections = flattenSectionEntries(document.sections);
    const rows = flatSections.map(({ section, depth }) => ({
      title: `${"  ".repeat(depth - 1)}${section.number ? `${section.number} ` : ""}${section.title}${section.link?.href ? " ↗" : ""}`,
      section,
      depth,
    }));

    list.setItems(rows.length > 0 ? rows.map((row) => row.title) : ["No sections found."]);
    list.setLabel(" Sections ");
    if (rows.length > 0) {
      list.select(0);
    }

    const showSelected = (index: number): void => {
      const item = rows[index];
      if (!item) {
        return;
      }
      previewPaging.pages = paginateSectionPreview(item.section);
      previewPaging.pageIndex = 0;
      previewPaging.sectionStatus = `Loaded: ${resolved}  •  Section ${index + 1}/${rows.length}`;
      renderPreviewPage(preview, status, screen, previewPaging);
    };

    list.removeAllListeners("select item");
    list.on("select item", (_item: unknown, index: number | string) => {
      const nextIndex = Number(index ?? 0);
      if (Number.isFinite(nextIndex) && nextIndex >= 0) {
        showSelected(nextIndex);
      }
    });

    if (rows[0]) {
      showSelected(0);
    } else {
      previewPaging.pages = [];
      previewPaging.pageIndex = 0;
      previewPaging.sectionStatus = `Loaded: ${resolved}  •  0 sections`;
      preview.setContent("No sections found.");
      status.setContent(previewPaging.sectionStatus);
    }

    list.focus();
    screen.render();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    status.setContent(`Error: ${message}`);
    preview.setContent(`Failed to load path.\n\n${message}`);
    screen.render();
  }
}

export function startTui(): void {
  const screen = blessed.screen({
    title: "Docs Decomposer",
    dockBorders: true,
    fullUnicode: true,
    autoPadding: true,
  });

  const status = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: "100%",
    height: 3,
    border: "line",
    style: { border: { fg: "cyan" } },
    content: "Docs Decomposer — Enter a PDF path and press Enter",
  });

  const rootDocsDir = resolve(process.cwd(), "docs");
  const state = {
    currentDirectory: rootDocsDir,
    entries: [] as Array<{ name: string; fullPath: string; isDirectory: boolean; isPdf: boolean }>,
    mode: "directory" as "directory" | "sections",
  };
  const previewPaging: PreviewPagingState = {
    pages: [],
    pageIndex: 0,
    sectionStatus: "",
  };

  const input = blessed.textbox({
    parent: screen,
    top: 3,
    left: 0,
    width: "100%",
    height: 3,
    border: "line",
    label: " PDF path ",
    keys: true,
    inputOnFocus: true,
    value: rootDocsDir,
    mouse: true,
  });

  const list = blessed.list({
    parent: screen,
    top: 7,
    left: 0,
    width: "40%",
    height: "80%",
    border: "line",
    label: " docs ",
    keys: true,
    mouse: true,
    vi: true,
    items: ["Loading docs..."],
    style: { selected: { bg: "blue", fg: "white" } },
  });

  const preview = blessed.box({
    parent: screen,
    top: 7,
    left: "40%",
    width: "60%",
    height: "80%",
    border: "line",
    label: " Preview ",
    scrollable: true,
    alwaysScroll: true,
    mouse: true,
    padding: { left: 1, right: 1, top: 0, bottom: 0 },
    content: "Select a section from the left to preview its content.",
  });

  const renderDirectory = async (directoryPath: string): Promise<void> => {
    state.currentDirectory = directoryPath;
    state.mode = "directory";
    previewPaging.pages = [];
    previewPaging.pageIndex = 0;
    previewPaging.sectionStatus = "";
    list.setLabel(" docs ");
    input.setValue(directoryPath);

    try {
      const entries = await readdir(directoryPath, { withFileTypes: true });
      const listing = await Promise.all(entries.map(async (entry) => {
        const fullPath = resolve(directoryPath, entry.name);
        const info = await stat(fullPath);
        return {
          name: entry.name,
          fullPath,
          isDirectory: info.isDirectory(),
          isPdf: !info.isDirectory() && fullPath.toLowerCase().endsWith(".pdf"),
          size: info.size,
          modifiedAt: info.mtime,
        };
      }));

      state.entries = listing;
      list.removeAllListeners("select item");
      list.setItems(listing.map((entry) => `${entry.name}${entry.isDirectory ? "/" : entry.isPdf ? " [PDF]" : ""}`));
      list.select(0);
      preview.setContent(formatDirectoryListing(listing));
      status.setContent(`Directory: ${directoryPath}  •  ${listing.length} entries`);
      list.focus();
      screen.render();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      status.setContent(`Error: ${message}`);
      preview.setContent(`Failed to open directory.\n\n${message}`);
      screen.render();
    }
  };

  const openPdfFile = async (pdfPath: string): Promise<void> => {
    state.mode = "sections";
    await loadPdf(list, preview, status, { getValue: () => pdfPath }, screen, previewPaging, async (nextPath) => {
      await renderDirectory(nextPath);
    });
  };

  const movePreviewPage = (offset: number): void => {
    const nextPage = Math.max(0, Math.min(previewPaging.pageIndex + offset, previewPaging.pages.length - 1));
    if (nextPage === previewPaging.pageIndex || previewPaging.pages.length === 0) {
      return;
    }
    previewPaging.pageIndex = nextPage;
    renderPreviewPage(preview, status, screen, previewPaging);
  };

  const activateSelected = (index: number): void => {
    if (state.mode !== "directory") {
      return;
    }

    const entry = state.entries[index];
    if (entry?.isDirectory) {
      void renderDirectory(entry.fullPath);
    } else if (entry?.isPdf) {
      void openPdfFile(entry.fullPath);
    }
  };

  const goBack = (): void => {
    if (state.mode === "sections") {
      void renderDirectory(state.currentDirectory);
      return;
    }

    if (state.currentDirectory !== rootDocsDir) {
      const parentDirectory = dirname(state.currentDirectory);
      if (parentDirectory === rootDocsDir || parentDirectory.startsWith(`${rootDocsDir}${sep}`)) {
        void renderDirectory(parentDirectory);
      }
    }
  };

  list.on("select", (_item: unknown, index: number) => {
    activateSelected(index);
  });
  list.on("cancel", goBack);

  input.on("submit", () => {
    void loadPdf(list, preview, status, input, screen, previewPaging, async (nextPath) => {
      await renderDirectory(nextPath);
    });
  });

  preview.on("wheelup", () => movePreviewPage(-1));
  preview.on("wheeldown", () => movePreviewPage(1));

  screen.key(["q", "C-c"], () => process.exit(0));
  screen.key(["pageup"], () => movePreviewPage(-1));
  screen.key(["pagedown"], () => movePreviewPage(1));

  void renderDirectory(rootDocsDir);
  screen.render();
  list.focus();
}

if (process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`) {
  startTui();
}
