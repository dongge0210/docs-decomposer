import assert from "node:assert/strict";
import test from "node:test";
import { parseContentsEntries } from "../src/pdf.js";
import { parseSections, renderMarkdown } from "../src/processor.js";

test("builds a nested section tree from numbered headings", () => {
  const document = parseSections(
    "Intro text\n\n1 First chapter\nChapter text\n\n1.1 First subsection\nDetails\n\n2 Second chapter\nMore text",
  );

  assert.equal(document.preamble, "Intro text");
  assert.equal(document.sections.length, 2);
  assert.equal(document.sections[0]?.title, "First chapter");
  assert.equal(document.sections[0]?.children[0]?.title, "First subsection");
  assert.equal(document.sections[0]?.content, "Chapter text");
  assert.equal(document.sections[1]?.content, "More text");
});

test("renders the section tree as a complete Markdown document", () => {
  const document = parseSections("1 First chapter\nText\n\n1.1 Subsection\nMore");

  assert.equal(
    renderMarkdown(document),
    "# 1 First chapter\n\nText\n\n## 1.1 Subsection\n\nMore\n",
  );
});

test("accepts Markdown headings and preserves text before the first heading", () => {
  const document = parseSections("Cover\n\n## Details\nBody");

  assert.equal(document.preamble, "Cover");
  assert.equal(document.sections[0]?.level, 2);
  assert.equal(document.sections[0]?.content, "Body");
});

test("renders linked section titles as explicit markdown links", () => {
  const document = {
    preamble: "",
    sections: [{
      id: "introduction",
      title: "Introduction",
      level: 1,
      page: 3,
      content: "Body",
      children: [],
      link: { href: "#page-3", label: "Introduction" },
    }],
  };

  assert.equal(
    renderMarkdown(document),
    "# [Introduction](#page-3)\n\n<!-- source page: 3 -->\n\nBody\n",
  );
});

test("skips table-of-contents entries and starts at the chapter heading", () => {
  const document = parseSections(
    "Contents\n1 First chapter 3\n1.1 Subsection . . . 4\n\nChapter 1. First chapter\nBody",
  );

  assert.equal(document.sections.length, 1);
  assert.equal(document.sections[0]?.title, "First chapter");
  assert.equal(document.sections[0]?.content, "Body");
});

test("parses numbered contents entries and strips dot leaders", () => {
  const entries = parseContentsEntries([
    [],
    [
      "Contents",
      "1 NVML API Reference 3",
      "1.1 API Documentation . . . . . . . 3",
      "2 Known Issues 5",
      "Chapter 1. NVML API Reference",
    ],
  ]);

  assert.deepEqual(entries, [
    { number: "1", title: "NVML API Reference", page: 3 },
    { number: "1.1", title: "API Documentation", page: 3 },
    { number: "2", title: "Known Issues", page: 5 },
  ]);
});

test("ignores hidden link markers in PDF contents titles", () => {
  const entries = parseContentsEntries([
    [
      "Contents",
      "1 Intro\u200Bduction 3",
      "1.1 API\u200B Documentation . . . . . . . 4",
      "2 Troubleshooting\u00A0Guide 8",
      "Chapter 1. Introduction",
    ],
  ]);

  assert.deepEqual(entries, [
    { number: "1", title: "Introduction", page: 3 },
    { number: "1.1", title: "API Documentation", page: 4 },
    { number: "2", title: "Troubleshooting Guide", page: 8 },
  ]);
});