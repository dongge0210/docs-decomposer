import assert from "node:assert/strict";
import test from "node:test";

import { flattenSectionRows, formatDirectoryListing, paginateSectionPreview } from "../src/tui.js";

test("flattens nested document sections into rows for the TUI", () => {
  const rows = flattenSectionRows([
    {
      id: "intro",
      title: "Introduction",
      level: 1,
      content: "Body",
      children: [
        {
          id: "intro-1",
          title: "Overview",
          level: 2,
          content: "More",
          children: [],
          link: { href: "#page-3", label: "Overview" },
        },
      ],
      link: { href: "#page-2", label: "Introduction" },
    },
  ]);

  assert.deepEqual(rows, [
    {
      title: "Introduction",
      depth: 1,
      page: undefined,
      href: "#page-2",
    },
    {
      title: "Overview",
      depth: 2,
      page: undefined,
      href: "#page-3",
    },
  ]);
});

test("formats directory listings in an ls -l style for the TUI", () => {
  const listing = formatDirectoryListing([
    { name: "docs", isDirectory: true, size: 0, modifiedAt: new Date("2024-01-15T12:00:00Z") },
    { name: "guide.pdf", isDirectory: false, size: 2048, modifiedAt: new Date("2024-01-16T08:30:00Z") },
  ]);

  assert.match(listing, /docs\/|guide\.pdf/);
  assert.match(listing, /d/);
  assert.match(listing, /2048/);
});

test("paginates long section previews without dropping body lines", () => {
  const section = {
    id: "5-2-1-7",
    title: "Example subsection",
    level: 4,
    number: "5.2.1.7",
    page: 92,
    content: Array.from({ length: 61 }, (_, index) => `Body line ${index + 1}`).join("\n"),
    children: [],
  };

  const pages = paginateSectionPreview(section, 25);

  assert.equal(pages.length, 3);
  assert.ok(pages.every((page) => page.includes("5.2.1.7 Example subsection")));
  assert.ok(pages.every((page) => page.includes("Body page ")));
  assert.deepEqual(
    pages.flatMap((page) => page.match(/Body line \d+/g) ?? []),
    Array.from({ length: 61 }, (_, index) => `Body line ${index + 1}`),
  );
});
