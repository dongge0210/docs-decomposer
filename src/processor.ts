export interface SectionLink {
  href: string;
  label?: string;
}

export interface Section {
  id: string;
  title: string;
  level: number;
  number?: string;
  page?: number;
  content: string;
  children: Section[];
  link?: SectionLink;
}

export interface ParsedDocument {
  preamble: string;
  sections: Section[];
  pageCount?: number;
}

interface SourceLine {
  text: string;
  page?: number;
}

interface Heading {
  title: string;
  level: number;
  number?: string;
}

function detectHeading(line: string): Heading | undefined {
  const chapterHeading = /^chapter\s+(\d+(?:\.\d+)*)(?:[.)])?\s+(.+?)\s*$/i.exec(line);
  if (chapterHeading) {
    const number = chapterHeading[1] ?? "";
    return { title: chapterHeading[2] ?? "", number, level: number.split(".").length };
  }

  const markdownHeading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
  if (markdownHeading) {
    return {
      title: markdownHeading[2] ?? "",
      level: markdownHeading[1]?.length ?? 1,
    };
  }

  const numberedHeading = /^(\d+(?:\.\d+)*)(?:[.)])?\s+(.+?)\s*$/.exec(line);
  if (!numberedHeading) {
    return undefined;
  }

  const title = numberedHeading[2] ?? "";
  if (!title || /(?:\.\s*){3,}\s*\d*\s*$/.test(title) || /^\d+$/.test(title)) {
    return undefined;
  }

  const number = numberedHeading[1] ?? "";
  return { title, number, level: number.split(".").length };
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "section";
}

export function parseSections(text: string): ParsedDocument {
  return parseLines(text.split(/\r?\n/).map((line) => ({ text: line })));
}

function parseLines(lines: SourceLine[]): ParsedDocument {
  const sections: Section[] = [];
  const preambleLines: string[] = [];
  const stack: Section[] = [];
  let inContents = false;

  for (const { text, page } of lines) {
    const trimmedLine = text.trim();
    if (!trimmedLine) {
      if (stack.length > 0) {
        const current = stack[stack.length - 1];
        if (current && current.content && !current.content.endsWith("\n")) {
          current.content += "\n";
        }
      } else if (preambleLines.length > 0 && preambleLines.at(-1) !== "") {
        preambleLines.push("");
      }
      continue;
    }

    if (/^contents$/i.test(trimmedLine)) {
      inContents = true;
      continue;
    }

    const heading = detectHeading(trimmedLine);
    if (inContents) {
      if (!/^chapter\s+\d/i.test(trimmedLine)) {
        continue;
      }
      inContents = false;
    }

    if (!heading) {
      const current = stack[stack.length - 1];
      if (current) {
        current.content += `${current.content ? "\n" : ""}${trimmedLine}`;
      } else {
        preambleLines.push(trimmedLine);
      }
      continue;
    }

    const section: Section = {
      id: slugify(heading.number ? `${heading.number}-${heading.title}` : heading.title),
      title: heading.title,
      level: heading.level,
      ...(heading.number ? { number: heading.number } : {}),
      ...(page ? { page } : {}),
      content: "",
      children: [],
    };

    while (stack.length > 0 && (stack.at(-1)?.level ?? 0) >= section.level) {
      stack.pop();
    }

    const parent = stack.at(-1);
    if (parent) {
      parent.children.push(section);
    } else {
      sections.push(section);
    }
    stack.push(section);
  }

  const trimSectionContent = (items: Section[]): void => {
    for (const section of items) {
      section.content = section.content.trim();
      trimSectionContent(section.children);
    }
  };
  trimSectionContent(sections);

  return {
    preamble: preambleLines.join("\n").trim(),
    sections,
  };
}

export function renderMarkdown(document: ParsedDocument): string {
  const output: string[] = [];

  if (document.preamble) {
    output.push(document.preamble);
  }

  const appendSections = (sections: Section[]): void => {
    for (const section of sections) {
      const depth = Math.min(section.level, 6);
      const title = section.number ? `${section.number} ${section.title}` : section.title;
      const displayTitle = section.link?.href ? `[${title}](${section.link.href})` : title;
      output.push(`${"#".repeat(depth)} ${displayTitle}`);
      if (section.page) {
        output.push(`<!-- source page: ${section.page} -->`);
      }
      if (section.content.trim()) {
        output.push(section.content.trim());
      }
      appendSections(section.children);
    }
  };

  appendSections(document.sections);
  return `${output.join("\n\n").trimEnd()}\n`;
}

export { slugify };
export type { SourceLine };
export { parseLines };