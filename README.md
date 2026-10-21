# Docs Decomposer

[English](README.md) | [简体中文](README.zh-CN.md)

TypeScript PDF document processor with a token-efficient MCP server.

- Extracts PDF text with PDF.js and builds a nested section tree from the table of contents and bookmarks.
- Exposes documents through MCP tools with paged outlines, section search, and capped section reads, so an agent never has to ingest a whole PDF at once.
- Supports absolute or allowed-root-relative paths, project root registration, and optional resources and prompts.

## Quick start

```sh
npm install
npm test
npm run build
DOCS_DECOMPOSER_ROOTS="$PWD/docs" npm run mcp
```

## MCP client configuration

This is the form used by the project's `.mcp.json`:

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

`DOCS_DECOMPOSER_HOME` is expanded by `sh` to locate the project; `DOCS_DECOMPOSER_ROOTS` is the document directory the server is allowed to read.

A simpler form without the shell wrapper:

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

See [USAGE.md](USAGE.md) for tool flows, pagination, resources, prompts, root safety, and the `register_root` workflow.

## Commands

| Command | Purpose |
|---|---|
| `npm run process -- docs/<file>.pdf` | Print the full Markdown extraction to stdout |
| `npm run mcp` | Start the stdio MCP server |
| `npm test` | Run the test suite |
| `npm run build` | Type-check the project |

## License

MIT

