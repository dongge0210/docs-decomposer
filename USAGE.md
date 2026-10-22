# Usage

[English](USAGE.md) | [简体中文](USAGE.zh-CN.md)

Docs Decomposer is a stdio MCP server that decomposes a PDF into a section tree so AI clients can read it on demand, page by page, instead of loading the whole document into context.

## Starting the server

```sh
# Allow access to ./docs
DOCS_DECOMPOSER_ROOTS="$PWD/docs" npm run mcp

# Debug mode: include per-depth section counts
DEBUG=1 DOCS_DECOMPOSER_ROOTS="$PWD/docs" npm run mcp
```

`DOCS_DECOMPOSER_ROOTS` separates multiple directories with `:`. When unset, only the server's startup directory is allowed.

## Terminal browser

Run `npm run tui` from the project directory to browse the local `docs/` directory and open a PDF. Press Enter to open the selected directory or PDF; press Esc to return to the document list or parent directory. In the section view, PageUp/PageDown or the mouse wheel moves through the preview.

Long section previews are displayed in pages of 24 extracted text lines. These are reading pages, not printed PDF pages; a single section may span many printed pages before the next heading.

## Remembering a document directory (no environment variables)

If a client cannot reliably pass environment variables, let the AI call `register_root`:

```json
{
  "path": "docs"
}
```

- The project path is fixed at server startup: `DOCS_DECOMPOSER_PROJECT`, or the server working directory when unset. **The client cannot change the scope through arguments.**
- `path` may be relative to the project directory or absolute.
- The document directory must be inside the project directory; escapes and the filesystem root are rejected.
- The server stores the project-to-document mapping in `~/.config/docs-decomposer/roots.json` (override with `DOCS_DECOMPOSER_CONFIG`).
- Stored roots are re-checked against the project directory when loaded.
- The change applies immediately and is loaded automatically on later startups by project path.

Startup root precedence:

1. `DOCS_DECOMPOSER_ROOTS`
2. The registered mapping for the project (`source: "registered"`)
3. The server working directory (`source: "current-directory"`, with a warning)

`list_roots` returns the current roots, `source`, `projectPath`, and `configPath` so callers can confirm which directory is in use.

All core capabilities are tools. Even when a client does not support prompts or resources, `register_root`, paged analysis, search, and section reads still work; prompts and resources are optional enhancements.

## Directory safety

The server is read-only, but a misconfigured root could let an agent read PDFs it should not. Protections:

- **Configure roots explicitly**: point `DOCS_DECOMPOSER_ROOTS` at a document directory, never at a project root, home directory, or `/`.
- **Startup log**: the server prints allowed roots to stderr; when the environment variable is unset it also warns that it is using the startup directory.
- **Visible root source**: `list_roots` returns canonical paths and `source` (`environment`, `registered`, `current-directory`, or `explicit`).
- **Responses include `root`**: `analyze_document`, `get_section`, `search_sections`, and `export_markdown` report which allowed root the file came from.
- **Dangerous roots rejected**: the filesystem root (`/` or `C:\`) cannot be an allowed root.
- **Read-only PDFs**: only `.pdf` files; traversal, symlink escapes, and out-of-root paths are rejected.

## Client configuration

Claude Desktop / Claude Code example, matching the project's `.mcp.json`:

```json
{
  "mcpServers": {
    "docs-decomposer": {
      "command": "sh",
      "args": ["-c", "exec npm --prefix \"$DOCS_DECOMPOSER_HOME\" run mcp"],
      "env": {
        "DOCS_DECOMPOSER_HOME": "/path/to/docs_Decomposer",
        "DOCS_DECOMPOSER_ROOTS": "/path/to/documents"
      }
    }
  }
}
```

Without the shell wrapper:

```json
{
  "mcpServers": {
    "docs-decomposer": {
      "command": "npm",
      "args": ["--prefix", "/path/to/docs_Decomposer", "run", "mcp"],
      "env": {
        "DOCS_DECOMPOSER_ROOTS": "/path/to/documents"
      }
    }
  }
}
```

Use the same command in MCP Inspector and choose the stdio transport.

## Tools

| Tool | Purpose | Main parameters |
|---|---|---|
| `list_roots` | Show allowed roots, their source, and the project path | none |
| `register_root` | Remember a project's document directory for later sessions | `path` |
| `list_directory` | List PDFs and subdirectories | `path` (omit to list roots) |
| `analyze_document` | Read the section tree without section bodies | `path`, `parentSectionNumber`, `maxDepth=3`, `maxSections=100`, `offset=0` |
| `search_sections` | Search titles and numbers without bodies | `path`, `query`, `maxResults=20` |
| `get_section` | Read one section body | `path`, `sectionNumber`, `maxChars=20000`, `offset=0` |
| `export_markdown` | Export the whole document as Markdown (large) | `path` |

Every `path` parameter accepts an **absolute** path or a path **relative to an allowed root**; multiple roots are tried in order. Relative paths are not resolved against the client cwd.

### Recommended flow

1. Use `list_roots` / `list_directory` to find the target PDF.
2. Call `analyze_document` with `maxDepth: 2` to see the overall structure.
3. If `hasMore: true`, continue with `nextOffset`; use `maxSections` to control page size.
4. To inspect a branch, pass `parentSectionNumber` (for example `"5.2"`).
5. To find a topic, `search_sections` costs far fewer tokens than walking the outline.
6. Use `get_section` on matching sections. It returns up to 20,000 characters by default (up to 200,000 per call); when `truncated: true`, pass the returned `nextOffset` as `offset` in the next call and continue until `truncated: false`.
7. Call `export_markdown` only when the full document is genuinely needed.

### Pagination fields

- `analyze_document`: `hasMore`, `nextOffset`, `omittedByDepth` (sections omitted by `maxDepth`)
- `get_section`: `truncated`, `contentOffset`, `totalChars`, `nextOffset`; offsets count characters in the extracted section body, not PDF page numbers.
- `search_sections`: `matchCount`, `returnedCount`, `truncated`

Any response that may exceed a limit includes a `hint` naming the next step:

- Outline paged → continue with `offset=nextOffset`, or narrow with `parentSectionNumber`
- Deeper sections omitted → raise `maxDepth` or pass `parentSectionNumber`
- Content truncated → continue with `offset=nextOffset` until `truncated` is false; each response reports cumulative progress in characters
- No search matches → try a shorter keyword or a section number prefix
- Search truncated → narrow the query or raise `maxResults`

`get_section` returns 20,000 characters by default and accepts up to 200,000 characters per call. For a long section, keep calling it with the response's `nextOffset` as the next `offset` until `truncated` is `false`. Offsets refer to characters in the extracted body, not printed PDF pages; for example, content under `5.2.1.7` can continue from printed page 92 up to the next heading on page 209 and must be read across multiple calls.

## Resources

- `resources/list` lists every PDF under the allowed roots.
- `resources/read` returns a document's section outline as Markdown, not the body.
- `resources/templates/list` advertises `docs-decomposer://pdf/{path}`.

When an outline exceeds 100 sections, it starts with a line pointing back to `analyze_document` (paging) and `search_sections` (topic lookup).

## Prompts

The server provides three workflow templates. Clients show them in the Prompts panel (for example, MCP Inspector); each returns standard instructions for the model to follow.

| Prompt | Arguments | Purpose |
|---|---|---|
| `document-overview` | `path` | Inspect the overall structure, then produce a guided overview |
| `find-topic` | `path`, `topic` | Search, read relevant sections, and summarize |
| `explain-section` | `path`, `sectionNumber` | Read one section fully and explain it |

Example: calling `find-topic` with `{ "path": "NVML_API_Reference_Guide.pdf", "topic": "device queries" }` returns instructions to call `search_sections`, read matches with `get_section`, and answer with section and page references.

## Pages and Index

- Every tool response includes `pageCount` (physical PDF pages).
- A section's `page` is the printed page number from the contents or bookmarks.
- Unnumbered trailing bookmarks such as `Index` become their own root sections instead of being absorbed into the previous section.
