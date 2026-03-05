# getnote-mcp

MCP (Model Context Protocol) server for [Get笔记](https://biji.com) Open API.

## Features

Exposes the following tools to AI models:

| Tool | Description |
|------|-------------|
| `list_notes` | 获取笔记列表（游标分页） |
| `get_note` | 获取笔记详情 |
| `save_note` | 创建或编辑笔记（纯文本/链接，见下方类型限制） |
| `delete_note` | 删除笔记（移入回收站） |
| `add_note_tags` | 添加笔记标签 |
| `delete_note_tag` | 删除笔记标签 |
| `list_topics` | 获取知识库列表 |
| `create_topic` | 创建知识库 |
| `list_topic_notes` | 获取知识库笔记列表 |
| `batch_add_notes_to_topic` | 批量添加笔记到知识库 |
| `remove_note_from_topic` | 从知识库移除笔记 |
| `get_upload_config` | 获取图片上传配置 |
| `get_upload_token` | 获取图片上传凭证（预签名 URL） |
| `get_quota` | 查询 API 调用配额 |

## Installation

```bash
npm install
npm run build
```

## Usage

### Environment variable

```bash
GETNOTE_API_KEY=your_api_key node dist/index.js
```

### CLI flag

```bash
node dist/index.js --api-key your_api_key
```

## Claude Desktop Configuration

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "getnote": {
      "command": "node",
      "args": ["/path/to/getnote-mcp/dist/index.js"],
      "env": {
        "GETNOTE_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

## Limits

| Item | Limit |
|------|-------|
| 每日知识库创建上限 | 每个账号每天最多创建 **50 个知识库** |
| 重置时间 | 按 **Europe/Berlin 时区**自然日 00:00 重置 |

> ⚠️ 超出限制时，`create_topic` 接口将返回 429 错误（`reason: quota_day`）。

## Notes on Note Types

`save_note` currently supports **two note types** only:

| Type | Description |
|------|-------------|
| `plain_text` | 纯文本笔记（默认） |
| `link` | 链接笔记（需传 `link_url`） |

> **⚠️ 限制说明**：图片笔记、语音笔记等其他类型**只能在 Get笔记 App 或 Web 端创建**，MCP 工具可以通过 `get_note` / `list_notes` 读取这些笔记，但无法通过 MCP 创建。

## API

- **Base URL**: `https://open.getnotes.cn/api/v1`
- **Auth**: Bearer Token (API Key)

Get your API Key at [Get笔记开放平台](https://biji.com/developer).

## License

MIT
