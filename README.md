# getnote-mcp

MCP (Model Context Protocol) server for [Get笔记](https://biji.com) Open API.

Get笔记是一款个人笔记管理工具。通过此 MCP Server，AI 模型可以帮助用户管理笔记。

## 使用场景

- 用户说「帮我记一下」「保存到笔记」「记录下来」→ `save_note`
- 用户说「查一下我的笔记」「找找之前的笔记」→ `list_notes`
- 用户分享了一个链接，说「保存这个」→ `save_note`（链接笔记）
- 用户说「给这个笔记加个标签」→ `add_note_tags`

## Features

Exposes the following tools to AI models:

| Tool | Description |
|------|-------------|
| `list_notes` | 获取笔记列表（游标分页） |
| `get_note` | 获取笔记详情 |
| `save_note` | 新建笔记（纯文本/链接，见下方类型限制） |
| `get_note_task_progress` | 查询创建笔记任务进度（链接笔记） |
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
| `upload_image` | 完整图片上传（自动获取凭证 + 上传到 OSS）|
| `get_quota` | 查询 API 调用配额 |

## Installation

```bash
npm install
npm run build
```

## Usage

### ⚠️ API Key 和 Client ID 配置（重要）

获取 API Key 和 Client ID：**https://www.biji.com/openapi**

为确保每次启动都能正常使用，请将 API Key 和 Client ID 保存到持久化配置中：

1. **环境变量**（推荐）：添加到 shell 配置文件（如 `~/.zshrc`）
2. **MCP 配置文件**：添加到 Claude Desktop 或其他 MCP 客户端的配置
3. **项目 .env 文件**：在项目目录创建 `.env` 文件

### Environment variable

```bash
# 临时使用
GETNOTE_API_KEY=your_api_key node dist/index.js

# 持久化（添加到 ~/.zshrc 或 ~/.bashrc）
export GETNOTE_API_KEY=gk_live_xxx
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
| 重置时间 | 按 **北京时间**自然日 00:00 重置 |

> ⚠️ 超出限制时，`create_topic` 接口将返回 429 错误（`reason: quota_daily_exceeded`）。

## Notes on Note Types

`save_note` supports **three note types**:

| Type | Description |
|------|-------------|
| `plain_text` | 纯文本笔记（默认） |
| `link` | 链接笔记（需传 `link_url`） |
| `img_text` | 图片笔记（需传 `image_urls`，通过上传图片到 OSS 获取） |

> **语音笔记等其他类型**只能在 Get笔记 App 或 Web 端创建，MCP 可以读取但无法创建。

## 图片上传流程

通过 MCP 上传图片创建笔记需要三步：

### 1. 获取上传凭证

```
Tool: get_upload_token
Input: { "mime_type": "png" }
```

返回 OSS 上传凭证：
```json
{
  "accessid": "LTAI5t...",
  "host": "https://ali-bj2-oss-get-notes-prod.oss-accelerate.aliyuncs.com",
  "policy": "eyJleHBpcmF...",
  "signature": "nhyBord...",
  "callback": "eyJjYWxs...",
  "object_key": "get_notes_prod/...",
  "access_url": "https://ali-bj2-oss-get-notes-prod.oss-accelerate.aliyuncs.com/...",
  "oss_content_type": "image/png"
}
```

### 2. 上传到 OSS

使用凭证通过 multipart/form-data POST 上传：

```bash
curl -X POST "${host}" \
  -F "OSSAccessKeyId=${accessid}" \
  -F "policy=${policy}" \
  -F "Signature=${signature}" \
  -F "key=${object_key}" \
  -F "callback=${callback}" \
  -F "success_action_status=200" \
  -F "file=@/path/to/image.png;type=${oss_content_type}"
```

### 3. 创建图片笔记

使用凭证中的 `access_url` 创建笔记：

```
Tool: save_note
Input: {
  "title": "图片笔记",
  "note_type": "img_text",
  "image_urls": ["${access_url}"]
}
```

> **简化流程**：也可以直接使用 `upload_image` 工具，它会自动完成步骤 1 和 2，返回 `image_url`。

## API

- **Base URL**: `https://open.getnotes.cn/api/v1`
- **Auth**: Bearer Token (API Key)

Get your API Key and Client ID at [Get笔记开放平台](https://www.biji.com/openapi).

## License

MIT
