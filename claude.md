# Docs Decomposer

## Project

TypeScript-based document processor. The current MVP extracts PDF text, uses the table of contents to build a nested section tree, and writes the complete Markdown result to stdout.

The current scope is the processing core, CLI, and stdio MCP server. There is no browser UI, desktop folder navigator, or HTML exporter yet.

## Implementation

- `src/pdf.ts` extracts page text with PDF.js. It parses numbered contents entries and printed page numbers, uses PDF bookmarks to locate matching body headings, and falls back to bookmarks or text heading detection when needed. Unnumbered top-level bookmarks after the last contents entry (for example `Index`) become their own root sections instead of being absorbed into the preceding section body.
- `src/processor.ts` builds the section tree and renders Markdown.
- `src/cli.ts` accepts a PDF path and writes the full Markdown document to stdout.
- `src/mcp-server.ts` exposes authorized PDF directories, shallow section trees, individual sections, and full Markdown through MCP tools. `resources/list` also exposes every PDF under the allowed roots (`docs-decomposer://pdf/<encoded absolute path>`); `resources/read` returns that document's section outline as Markdown, not the full body. `prompts/list` returns an empty list. The resource handlers also prevent clients from seeing `-32601` when they probe these methods.
  - `analyze_document` defaults to depth 3 and at most 100 sections; use `parentSectionNumber` to scope a branch and `offset`/`maxSections` to page through long outlines. Responses report `hasMore` and `nextOffset`.
  - `search_sections` matches section titles and numbers without returning bodies, so agents can locate a section before reading it.
  - `get_section` caps content at 20,000 characters; use `maxChars`/`offset` to page, with `truncated` and `nextOffset` in the response.
  - When output is truncated by depth, section-count limits, search limits, or `maxChars`, the response includes a `hint` that names the next call to make. Resource outlines over 100 sections start with the same guidance.
  - `ParsedDocument.pageCount` comes from `pdf.numPages`; tool responses include `pageCount`, and resource outlines start with a `# Title (N pages)` header.
  - `register_root` remembers a project-to-document-directory mapping in `~/.config/docs-decomposer/roots.json` (override with `DOCS_DECOMPOSER_CONFIG`). The project path is fixed at startup from `DOCS_DECOMPOSER_PROJECT` or the working directory; the client cannot choose it. The document directory must be inside that project path. Registered roots apply immediately and are loaded on later startups by project path, re-checking containment.
  - Startup root precedence: `DOCS_DECOMPOSER_ROOTS`, then the registered mapping for the project, then the current working directory. `list_roots` reports `source` (`environment`, `registered`, `current-directory`, `explicit`), `projectPath`, and `configPath`.
  - `prompts` exposes three workflow templates: `document-overview`, `find-topic`, and `explain-section`. These return tool-usage instructions, not document content. Prompts and resources are optional client support; every core capability is available through tools.
  - Set `DEBUG=1` in the server environment to include per-depth counts.
- `tests/processor.test.ts` covers section nesting, Markdown rendering, and contents parsing.
- `tests/mcp.test.ts` covers MCP tool calls and allowed-root path boundaries.
- `docs/` is intentionally Git-ignored and may contain local sample documents.

## Commands

```sh
npm install
npm test
npm run build
npm run process -- docs/<file>.pdf
DOCS_DECOMPOSER_ROOTS="$PWD/docs" npm run mcp
DEBUG=1 DOCS_DECOMPOSER_ROOTS="$PWD/docs" npm run mcp
```

## MCP Client Configuration

Configure the client to run `npm --prefix /path/to/docs_Decomposer run mcp` and set `DOCS_DECOMPOSER_ROOTS` to the document directories the server may access. Always set it explicitly to the document directory, never to a project root, home directory, or filesystem root. Add `DEBUG=1` to the server environment to include per-depth diagnostics. If roots are unset, the server falls back to its current working directory and prints a warning to stderr. At startup it prints the allowed roots to stderr; `list_roots` returns canonical paths plus the source, and analysis responses include `root`. The filesystem root is rejected as an allowed root. See [USAGE.md](USAGE.md) for client configuration, tool flows, resources, and prompts.

## Development Notes

- Keep the implementation in TypeScript and preserve the current ESM setup.
- Keep PDF extraction, section parsing, and rendering independently testable.
- Prefer the document's contents and bookmarks over title-shape guesses. Preserve section numbering and source page references.
- Do not add sample documents, generated exports, or dependencies to Git unless explicitly requested.
- Run `npm test` and `npm run build` after code changes. Check runtime dependencies with `npm audit --omit=dev` when changing PDF.js.
