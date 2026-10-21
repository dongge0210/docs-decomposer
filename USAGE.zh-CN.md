# 使用指南

[English](USAGE.md) | [简体中文](USAGE.zh-CN.md)

Docs Decomposer 是一个 stdio MCP 服务器，把 PDF 拆成章节树，供 AI 客户端按需、分页地读取，避免一次性把整本 PDF 塞进上下文。

## 启动

```sh
# 允许访问 ./docs 目录
DOCS_DECOMPOSER_ROOTS="$PWD/docs" npm run mcp

# 调试模式：返回每个层级的节数统计
DEBUG=1 DOCS_DECOMPOSER_ROOTS="$PWD/docs" npm run mcp
```

`DOCS_DECOMPOSER_ROOTS` 用 `:` 分隔多个目录。未设置时只允许访问服务器启动目录。

## 记住文档目录（无需环境变量）

如果客户端无法可靠传递 environment，可以让 AI 直接调用 `register_root`：

```json
{
  "path": "docs"
}
```

- 项目路径在服务器启动时确定：`DOCS_DECOMPOSER_PROJECT`，未设置时用服务器工作目录。**客户端不能通过参数改变作用域**
- `path` 可以是相对项目目录的路径，也可以是绝对路径
- 文档目录必须在项目目录内；越界和文件系统根会被拒绝
- 服务器把「项目 → 文档目录」映射写入 `~/.config/docs-decomposer/roots.json`，可用 `DOCS_DECOMPOSER_CONFIG` 覆盖位置
- 加载记录时会重新校验路径仍在项目目录内
- 当前会话立即生效；下次启动时按项目路径自动加载

启动时的根解析顺序：

1. `DOCS_DECOMPOSER_ROOTS` 环境变量
2. 该项目已登记的记录（`source: "registered"`）
3. 服务器当前工作目录（`source: "current-directory"`，并打印警告）

`list_roots` 返回当前根、`source`、`projectPath` 和 `configPath`，可以直接确认「现在用的目录对不对」。

所有核心能力都在 tools 中。即使客户端不支持 prompts 或 resources，`register_root`、分页分析、搜索和分节读取仍然可用；prompts/resources 只是增强。

## 目录安全

服务器只读，但根目录配错会让 AI 读到不该读的 PDF，所以做了这些保护：

- **显式配置根目录**：始终把 `DOCS_DECOMPOSER_ROOTS` 指向具体文档目录，不要指向项目根、家目录或 `/`。
- **启动日志**：服务器启动时会在 stderr 打印所有允许的根；未设置环境变量时会额外警告正在使用启动目录。
- **根来源可见**：`list_roots` 返回 canonical 路径和 `source`（`environment`、`registered`、`current-directory` 或 `explicit`），可以确认当前根是不是预期配置。
- **响应带 root**：`analyze_document`、`get_section`、`search_sections`、`export_markdown` 的返回都包含 `root`，能看出文件来自哪个允许根。
- **拒绝危险根**：文件系统根（`/` 或 `C:\`）不能作为允许根。
- **只读 PDF**：只接受 `.pdf` 文件；目录穿越、符号链接逃逸和越界路径都会被拒绝。

## 客户端配置

Claude Desktop / Claude Code 的 MCP 配置示例：

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

MCP Inspector 中用同样的命令连接，选择 stdio 传输即可。

## 工具

| 工具 | 用途 | 主要参数 |
|---|---|---|
| `list_roots` | 查看允许访问的根目录、来源和项目路径 | 无 |
| `register_root` | 记住某个项目的文档目录，下次自动加载 | `path` |
| `list_directory` | 列出目录下的 PDF 和子目录 | `path`（省略时列出根目录） |
| `analyze_document` | 读取章节树，不返回正文 | `path`、`parentSectionNumber`、`maxDepth=3`、`maxSections=100`、`offset=0` |
| `search_sections` | 按标题/编号搜索，不返回正文 | `path`、`query`、`maxResults=20` |
| `get_section` | 读取单节正文 | `path`、`sectionNumber`、`maxChars=20000`、`offset=0` |
| `export_markdown` | 导出整本 Markdown（体积很大） | `path` |

所有 `path` 参数都支持**绝对路径**或**相对于允许根的相对路径**；有多个根时按顺序尝试。相对路径不是相对于客户端 cwd。

### 推荐流程

1. `list_roots` / `list_directory` 找到目标 PDF。
2. `analyze_document` 先用 `maxDepth: 2` 看整体结构。
3. 如果返回 `hasMore: true`，用 `nextOffset` 继续翻页；翻页时用 `maxSections` 控制每页大小。
4. 想深入某个分支时，传 `parentSectionNumber`（如 `"5.2"`）再看该分支。
5. 找具体主题时，`search_sections` 比遍历目录省 token。
6. `get_section` 读取命中的节；`truncated: true` 时用 `nextOffset` 继续读。
7. 只有确实需要整本导出时才调用 `export_markdown`。

### 分页字段

- `analyze_document`：`hasMore`、`nextOffset`、`omittedByDepth`（因 `maxDepth` 省略的节数）
- `get_section`：`truncated`、`contentOffset`、`totalChars`、`nextOffset`
- `search_sections`：`matchCount`、`returnedCount`、`truncated`

所有可能超限的响应都会带 `hint` 字段，直接说明下一步：

- 目录被分页 → 用 `offset=nextOffset` 继续，或用 `parentSectionNumber` 缩小范围
- 深层被 `maxDepth` 省略 → 增大 `maxDepth` 或传 `parentSectionNumber`
- 正文被截断 → 用 `nextOffset` 续读
- 搜索无结果 → 换更短的关键词或章节号前缀
- 搜索结果被截断 → 缩小查询或增大 `maxResults`

## Resources

- `resources/list` 列出所有允许目录下的 PDF。
- `resources/read` 读取某个 PDF 时返回章节大纲（Markdown），不返回正文。
- `resources/templates/list` 提供 `docs-decomposer://pdf/{path}` 模板。

大纲超过 100 节时，开头会有一行提示，指回 `analyze_document`（分页）和 `search_sections`（定位主题）。

## Prompts

服务器提供 3 个工作流模板。客户端在 Prompts 面板（如 MCP Inspector）中可以看到并调用；调用后得到一段标准操作指令，再交给模型执行。

| Prompt | 参数 | 作用 |
|---|---|---|
| `document-overview` | `path` | 先看整体结构，再生成文档导读 |
| `find-topic` | `path`、`topic` | 搜索主题、读取相关章节并汇总 |
| `explain-section` | `path`、`sectionNumber` | 完整读取某一节并解释 |

示例：调用 `find-topic`，参数为 `{ "path": "NVML_API_Reference_Guide.pdf", "topic": "device queries" }`，返回的提示词会指导模型先调用 `search_sections`，再用 `get_section` 读取命中内容，最后带章节号和页码回答。

## 页数与 Index

- 所有工具响应都包含 `pageCount`（PDF 物理页数）。
- 正文中的 `page` 是文档印刷页码（来自目录或书签）。
- 目录之外的尾部无编号书签（如 `Index`）会作为独立顶层章节返回，不再并入前一节。
