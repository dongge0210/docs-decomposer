import { readFile } from "node:fs/promises";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { parseLines, type ParsedDocument, type Section } from "./processor.js";

type PdfDocument = Awaited<ReturnType<typeof getDocument>["promise"]>;

interface PdfTextItem {
  str: string;
  transform: number[];
  width: number;
}

interface PositionedText extends PdfTextItem {
  x: number;
  y: number;
}

interface PdfOutlineItem {
  title: string;
  dest: string | unknown[] | null;
  items?: PdfOutlineItem[];
}

interface ResolvedOutlineItem {
  source: PdfOutlineItem;
  level: number;
  number?: string;
  page: number;
  displayPage?: number;
  lineIndex: number;
  position: number;
  children: ResolvedOutlineItem[];
}

export interface ContentsEntry {
  number: string;
  title: string;
  page: number;
}

function isPdfTextItem(item: unknown): item is PdfTextItem {
  if (!item || typeof item !== "object") {
    return false;
  }
  const candidate = item as Partial<PdfTextItem>;
  return typeof candidate.str === "string" && Array.isArray(candidate.transform);
}

function sanitizePdfText(value: string): string {
  return value
    .replace(/[\u0000-\u001F\u007F\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/[\u00A0\u1680\u180E\u2007\u202F]/g, " ");
}

function groupPageText(items: unknown[]): string[] {
  const positioned = items
    .filter(isPdfTextItem)
    .map((item) => ({
      ...item,
      x: item.transform[4] ?? 0,
      y: item.transform[5] ?? 0,
    }))
    .sort((left, right) => right.y - left.y || left.x - right.x);

  const rows: PositionedText[][] = [];
  for (const item of positioned) {
    let row = rows.find((candidate) => Math.abs((candidate[0]?.y ?? 0) - item.y) < 2.5);
    if (!row) {
      row = [];
      rows.push(row);
    }
    row.push(item);
  }

  return rows
    .map((row) => {
      const orderedRow = row.sort((left, right) => left.x - right.x);
      let line = "";
      let previous: PositionedText | undefined;
      for (const item of orderedRow) {
        if (previous && item.x - (previous.x + previous.width) > 1.5) {
          line += " ";
        }
        line += sanitizePdfText(item.str);
        previous = item;
      }
      return sanitizePdfText(line).trim();
    })
    .filter(Boolean);
}

function normalizeHeading(value: string): string {
  return sanitizePdfText(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function parseContentsEntries(pageLines: string[][]): ContentsEntry[] {
  const entries: ContentsEntry[] = [];
  let inContents = false;
  let pending: { number: string; title: string } | undefined;

  const appendEntry = (number: string, rawTitle: string, page: number): void => {
    const title = sanitizePdfText(rawTitle)
      .replace(/(?:\s*\.\s*){2,}\s*$/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (title) {
      entries.push({ number, title, page });
    }
  };

  for (const lines of pageLines) {
    for (const rawLine of lines) {
      const line = sanitizePdfText(rawLine).trim();
      if (!inContents) {
        if (/^(?:table of )?contents$/i.test(line)) {
          inContents = true;
        }
        continue;
      }

      if (/^chapter\s+\d/i.test(line)) {
        return entries;
      }

      const completeEntry = /^(\d+(?:\.\d+)*)(?:[.)])?\s+(.+?)\s+(\d+)\s*$/.exec(line);
      if (completeEntry) {
        const number = completeEntry[1] ?? "";
        appendEntry(number, completeEntry[2] ?? "", Number(completeEntry[3]));
        pending = undefined;
        continue;
      }

      const pageOnly = /^(\d+)$/.exec(line);
      if (pageOnly && pending) {
        appendEntry(pending.number, pending.title, Number(pageOnly[1]));
        pending = undefined;
        continue;
      }

      const partialEntry = /^(\d+(?:\.\d+)*)(?:[.)])?\s+(.+)$/.exec(line);
      if (partialEntry) {
        pending = {
          number: partialEntry[1] ?? "",
          title: partialEntry[2] ?? "",
        };
      } else if (pending) {
        pending.title += ` ${line}`;
      }
    }
  }

  return entries;
}

async function resolveOutline(
  pdf: PdfDocument,
  pageLines: string[][],
): Promise<ResolvedOutlineItem[]> {
  const outline = (await pdf.getOutline()) as PdfOutlineItem[] | null;
  if (!outline?.length) {
    return [];
  }

  const pageOffsets: number[] = [];
  let offset = 0;
  for (const lines of pageLines) {
    pageOffsets.push(offset);
    offset += lines.length;
  }

  const cursors = new Map<number, number>();
  const resolveItems = async (
    items: PdfOutlineItem[],
    level: number,
  ): Promise<ResolvedOutlineItem[]> => {
    const resolved: ResolvedOutlineItem[] = [];
    for (const source of items) {
      const destination = typeof source.dest === "string"
        ? await pdf.getDestination(source.dest)
        : source.dest;
      if (!Array.isArray(destination) || !destination[0]) {
        continue;
      }

      const pageIndex = await pdf.getPageIndex(destination[0]);
      const lines = pageLines[pageIndex] ?? [];
      const normalizedTitle = normalizeHeading(source.title);
      const cursor = cursors.get(pageIndex) ?? 0;
      let lineIndex = lines.findIndex(
        (line, index) => index >= cursor && normalizeHeading(line).includes(normalizedTitle),
      );
      if (lineIndex < 0) {
        lineIndex = lines.findIndex((line) => normalizeHeading(line).includes(normalizedTitle));
      }
      if (lineIndex < 0) {
        lineIndex = cursor;
      }
      cursors.set(pageIndex, lineIndex + 1);

      const destinationName = typeof source.dest === "string" ? source.dest : "";
      const number = /(?:chapter|section)\.(\d+(?:\.\d+)*)/i.exec(destinationName)?.[1];
      const item: ResolvedOutlineItem = {
        source,
        level,
        ...(number ? { number } : {}),
        page: pageIndex + 1,
        lineIndex,
        position: (pageOffsets[pageIndex] ?? 0) + lineIndex,
        children: [],
      };
      item.children = await resolveItems(source.items ?? [], level + 1);
      resolved.push(item);
    }
    return resolved;
  };

  return resolveItems(outline, 1);
}

function flattenOutline(items: ResolvedOutlineItem[]): ResolvedOutlineItem[] {
  return items.flatMap((item) => [item, ...flattenOutline(item.children)]);
}

function locateContentsEntry(
  entry: ContentsEntry,
  pageLines: string[][],
  startPage: number,
  expectedPage: number,
): { page: number; lineIndex: number } | undefined {
  const normalizedTitle = normalizeHeading(entry.title);
  const pageIndexes = pageLines
    .map((_, index) => index)
    .filter((index) => index >= startPage)
    .sort((left, right) =>
      Math.abs(left + 1 - expectedPage) - Math.abs(right + 1 - expectedPage),
    );

  for (const pageIndex of pageIndexes) {
    const lines = pageLines[pageIndex] ?? [];
    const lineIndex = lines.findIndex((line) => normalizeHeading(line).includes(normalizedTitle));
    if (lineIndex >= 0) {
      return { page: pageIndex + 1, lineIndex };
    }
  }
}

function resolveContents(
  entries: ContentsEntry[],
  outline: ResolvedOutlineItem[],
  pageLines: string[][],
): ResolvedOutlineItem[] {
  const flattenedOutline = flattenOutline(outline);
  const outlineByNumber = new Map(
    flattenedOutline.flatMap((item) => item.number ? [[item.number, item] as const] : []),
  );
  const matchingOutline = (entry: ContentsEntry) => {
    const candidate = outlineByNumber.get(entry.number);
    return candidate && normalizeHeading(candidate.source.title) === normalizeHeading(entry.title)
      ? candidate
      : undefined;
  };

  const calibratedEntry = entries.find((entry) => matchingOutline(entry));
  let pageOffset: number | undefined;
  if (calibratedEntry) {
    pageOffset = (matchingOutline(calibratedEntry)?.page ?? calibratedEntry.page) - calibratedEntry.page;
  } else if (entries[0]) {
    const firstBodyPage = pageLines.findIndex((lines) =>
      lines.some((line) => /^chapter\s+\d/i.test(line.trim())),
    );
    const location = locateContentsEntry(
      entries[0],
      pageLines,
      Math.max(firstBodyPage, 0),
      entries[0].page,
    );
    if (location) {
      pageOffset = location.page - entries[0].page;
    }
  }

  const pageOffsets: number[] = [];
  let offset = 0;
  for (const lines of pageLines) {
    pageOffsets.push(offset);
    offset += lines.length;
  }

  const roots: ResolvedOutlineItem[] = [];
  const stack: ResolvedOutlineItem[] = [];
  for (const entry of entries) {
    const level = entry.number.split(".").length;
    const outlineMatch = matchingOutline(entry);
    const expectedPage = entry.page + (pageOffset ?? 0);
    const located = outlineMatch
      ? { page: outlineMatch.page, lineIndex: outlineMatch.lineIndex }
      : locateContentsEntry(
          entry,
          pageLines,
          Math.max(pageLines.findIndex((lines) =>
            lines.some((line) => /^chapter\s+\d/i.test(line.trim())),
          ), 0),
          expectedPage,
        );

    if (!located) {
      continue;
    }

    const number = entry.number;
    const page = located.page;
    const item: ResolvedOutlineItem = {
      source: { title: entry.title, dest: null },
      level,
      number,
      page,
      displayPage: entry.page,
      lineIndex: located.lineIndex,
      position: (pageOffsets[page - 1] ?? 0) + located.lineIndex,
      children: [],
    };

    while (stack.length > 0 && (stack.at(-1)?.level ?? 0) >= level) {
      stack.pop();
    }
    const parent = stack.at(-1);
    if (parent) {
      parent.children.push(item);
    } else {
      roots.push(item);
    }
    stack.push(item);
  }

  return roots;
}

function mergeUnlistedSections(
  sections: ResolvedOutlineItem[],
  outline: ResolvedOutlineItem[],
): ResolvedOutlineItem[] {
  const listedTitles = new Set(
    sections.map((item) => normalizeHeading(item.source.title)),
  );
  const lastListedPosition = sections.at(-1)?.position ?? 0;
  const unlisted = outline.filter((item) =>
    item.level === 1
    && !item.number
    && item.position > lastListedPosition
    && !listedTitles.has(normalizeHeading(item.source.title)),
  );
  if (unlisted.length === 0) {
    return sections;
  }
  return [...sections, ...unlisted].sort((left, right) => left.position - right.position);
}

function buildSectionsFromOutline(
  outline: ResolvedOutlineItem[],
  pageLines: string[][],
): ParsedDocument {
  const allLines = pageLines.flat();
  const firstPosition = outline[0]?.position ?? 0;
  const contentsPosition = allLines.findIndex((line) => /^contents$/i.test(line.trim()));
  const preambleEnd = contentsPosition >= 0 ? contentsPosition : firstPosition;
  const preamble = allLines.slice(0, preambleEnd).join("\n").trim();

  const buildItems = (items: ResolvedOutlineItem[], boundary: number): Section[] =>
    items.map((item, index) => {
      const nextSibling = items[index + 1]?.position ?? boundary;
      const firstChild = item.children[0]?.position ?? nextSibling;
      const content = allLines.slice(item.position + 1, firstChild).join("\n").trim();
      const children = buildItems(item.children, nextSibling);
      const title = item.source.title.trim();
      const href = item.source.dest ? `#page-${item.page}` : undefined;
      return {
        id: (item.number ? `${item.number}-${title}` : title)
          .toLowerCase()
          .normalize("NFKD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "") || "section",
        title,
        level: item.level,
        ...(item.number ? { number: item.number } : {}),
        page: item.displayPage ?? item.page,
        content,
        children,
        ...(href ? { link: { href } } : {}),
      };
    });

  return { preamble, sections: buildItems(outline, allLines.length) };
}

export async function processPdf(filePath: string): Promise<ParsedDocument> {
  const data = new Uint8Array(await readFile(filePath));
  const loadingTask = getDocument({ data });
  const pdf = await loadingTask.promise;

  try {
    const pageLines: string[][] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      pageLines.push(groupPageText(content.items));
      page.cleanup();
    }
    const outline = await resolveOutline(pdf, pageLines);
    const contents = parseContentsEntries(pageLines);
    if (contents.length > 0) {
      const sections = resolveContents(contents, outline, pageLines);
      if (sections.length > 0) {
        const mergedSections = mergeUnlistedSections(sections, outline);
        return { ...buildSectionsFromOutline(mergedSections, pageLines), pageCount: pdf.numPages };
      }
    }
    if (outline.length > 0) {
      return { ...buildSectionsFromOutline(outline, pageLines), pageCount: pdf.numPages };
    }
    return {
      ...parseLines(pageLines.flatMap((lines, index) =>
        lines.map((text) => ({ text, page: index + 1 })),
      )),
      pageCount: pdf.numPages,
    };
  } finally {
    await loadingTask.destroy();
  }
}