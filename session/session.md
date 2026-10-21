# Session State

Updated: 2026-10-21 19:52 CST

## Current Stage

The TypeScript PDF processing core and stdio MCP server are implemented. The server exposes directory browsing, depth-limited document analysis, individual section reading, and full Markdown export.

## Verified

- `npm test`: 11 tests pass, including MCP protocol, pagination, search, content truncation, long-outline hints, prompts, root registration, root safety, and path-boundary coverage. MCP text assertions now compare against `structuredContent` instead of the old `key=value` text format.
- MCP token budget on the NVML sample: `analyze_document` L3 is ~915 tokens (was ~1,670); L4 is paged at 100 sections, ~1,740 tokens per page (was ~9,300 for all 276); `search_sections` is ~250 tokens; `get_section` is capped at 20,000 characters (~5,200 tokens) instead of up to 223,008 characters.
- `register_root` lets an agent record a project-to-documents mapping without environment variables. It writes `~/.config/docs-decomposer/roots.json` (override: `DOCS_DECOMPOSER_CONFIG`). The project path is fixed at startup from `DOCS_DECOMPOSER_PROJECT` or the working directory — it is not a client parameter, so callers cannot widen the containment scope. Registered roots are re-checked against the project path when loaded. Startup precedence: env > registered > cwd. Verified end-to-end: register then `resolveStartupRoots` returns `source: "registered"`.
- Root safety: startup logs allowed roots to stderr and warns when falling back to cwd; `list_roots` returns canonical paths plus `source`; `analyze_document`/`get_section`/`search_sections`/`export_markdown` include `root`; the filesystem root is rejected. 10 tests pass.
- Truncated responses now carry a `hint` naming the next call: paging (`offset=nextOffset`), depth (`maxDepth`/`parentSectionNumber`), content continuation, or search refinement. Resource outlines over 100 sections start with the same guidance. 9 tests pass.
- `prompts` exposes `document-overview`, `find-topic`, and `explain-section`; each returns a tool-usage instruction with `path`/`topic`/`sectionNumber` arguments. `USAGE.md` documents startup, client configuration, tool flows, resources, and prompts.
- The NVML PDF's unnumbered trailing `Index` bookmark is now a separate root section (`page=597`, 185,308 chars) instead of being absorbed into `6.1 Trademarks`; section count is 277 and Trademarks dropped from 185,644 to 329 chars.
- `ParsedDocument.pageCount` is populated from `pdf.numPages` (651 for the NVML sample) and returned by `analyze_document`, `get_section`, and `search_sections`; resource outlines start with `# NVML API Reference Guide (651 pages)`.
- MCP resources expose PDFs found under the allowed roots. `resources/list` returns one resource per PDF (`docs-decomposer://pdf/<encoded absolute path>`), `resources/read` returns the section outline as Markdown (276 lines / ~13.7k chars for the NVML sample, not the 1.1 MB body), and `resources/templates/list` advertises `docs-decomposer://pdf/{path}`. `prompts/list` returns an empty list. Registering these handlers is also required by the SDK, which rejects resource handlers when the capability is not declared.
- `npm run build`: passes.
- `npm audit --omit=dev`: no runtime vulnerabilities.
- Local NVML PDF sample: all 276 contents entries match output sections; the contents pages are excluded from the exported body.
- Real MCP stdio client: lists all 5 tools and analyzes the local PDF as 276 sections.
- `analyze_document` defaults to L3: the sample returns 50 of 276 sections and omits 226 L4 entries; `parentSectionNumber` supports focused expansion and server environment `DEBUG=1` adds per-depth counts.
- Git ignores `docs/`, `node_modules/`, and `dist/`.

## Run

```sh
npm run process -- docs/<file>.pdf
DOCS_DECOMPOSER_ROOTS="$PWD/docs" npm run mcp
DEBUG=1 DOCS_DECOMPOSER_ROOTS="$PWD/docs" npm run mcp
```

## Next

Build the folder-like browsing experience or add HTML export. Keep the local PDF sample out of commits.
