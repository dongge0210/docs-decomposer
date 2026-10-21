# Docs Decomposer

[English](README.md) | [简体中文](README.zh-CN.md)

基于 TypeScript 的 PDF 文档处理工具，附带一个按需读取、节省 token 的 MCP 服务器。

- 使用 PDF.js 提取文本，并根据目录与书签构建嵌套章节树。
- 通过 MCP 工具提供分页目录、章节搜索和限量正文读取，AI 不需要一次吞下整本 PDF。
- 支持绝对路径或相对于允许根的路径、项目根目录登记，以及可选的 resources 和 prompts。

## 快速开始

```sh
npm install
npm test
npm run build
DOCS_DECOMPOSER_ROOTS="$PWD/docs" npm run mcp
```

## MCP 客户端配置

下面是本项目 `.mcp.json` 实际使用的形式：

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

`DOCS_DECOMPOSER_HOME` 由 `sh` 展开以定位项目目录；`DOCS_DECOMPOSER_ROOTS` 是服务器允许读取的文档目录。

不使用 shell 包装的简化形式：

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

工具流程、分页、resources、prompts、目录安全和 `register_root` 用法详见 [USAGE.zh-CN.md](USAGE.zh-CN.md)。

## 命令

| 命令 | 用途 |
|---|---|
| `npm run process -- docs/<file>.pdf` | 将完整 Markdown 提取结果输出到 stdout |
| `npm run mcp` | 启动 stdio MCP 服务器 |
| `npm test` | 运行测试 |
| `npm run build` | 类型检查 |

## 许可证

MIT
