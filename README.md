[![MseeP.ai Security Assessment Badge](https://mseep.net/pr/iswalle-getnote-mcp-badge.png)](https://mseep.ai/app/iswalle-getnote-mcp)

# getnote-mcp

MCP (Model Context Protocol) server for [得到大脑（Get笔记）](https://biji.com) Open API.

得到大脑（Get笔记）是一款个人笔记管理工具。通过此 MCP Server，AI 模型可以帮助用户管理笔记。

> 🔑 **获取 API Key**：https://www.biji.com/openapi
>
> 💡 **开通会员**：[前往得到大脑会员购买页](https://www.biji.com/checkout?product_alias=9Ab36BB3ZD&spm=openapi_mcp)

## 使用场景

### 1.8.0 新能力

- 标记 `get_note_marks`、发芽 `list_sprouts` / `get_sprout`、章节 `get_note_chapters` 与录音 `get_note_timeline` 独立读取。
- 文件上传前调用 `get_knowledge_file_capabilities` 获取实时格式、大小、页数与额度限制，不维护客户端白名单。
- `get_knowledge_file_upload_token` 获取临时凭据，本机使用 CLI 1.6.0+ 的 `getnote upload <文件> --token-file <受控文件> --max-size-bytes <能力上限>` 直传 OSS，无需 CLI 再登录。
- `upload_knowledge_file` 只提交文件元数据；用 `list_topic_directories` 确认同一资源达到 `SUCCESS`，不能把 OSS 上传完成当作解析完成。凭据只经 stdin 或受控文件传递，不出现在聊天或命令参数中。

- 用户说「帮我记一下」「保存到笔记」「记录下来」→ `save_note`
- 用户说「改一下这个笔记」「更新笔记内容」→ `update_note`
- 用户说「查一下我的笔记」「找找之前的笔记」→ `list_notes`
- 用户说「搜一下」「找找我哪些笔记提到了 XX」→ `recall`
- 用户说「在 XX 知识库搜一下」→ `recall_knowledge`
- 用户分享了一个链接，说「保存这个」→ `save_note`（链接笔记）
- 用户说「给这个笔记加个标签」→ `add_note_tags`
- 用户说「读这条链接笔记原文 / 读取会议转写」→ `get_note_original` / `get_note_transcript`
- 用户说「把笔记放进知识库的某个文件夹」→ `list_topic_directories` + `batch_add_notes_to_topic`
- 用户说「订阅这个抖音博主」→ `follow_topic_blogger`

## Features

Exposes the following tools to AI models:

| Tool | Description |
|------|-------------|
| `list_notes` | 获取笔记列表（游标分页） |
| `get_note` | 获取笔记详情（支持 `image_quality=original` 获取原图） |
| `get_note_original` | 按笔记类型直接读取原文 |
| `get_note_transcript` | 直接读取录音、会议或课堂转写 |
| `get_note_attachments` | 直接列出图片、音频和文件附件 |
| `get_note_timeline` | 直接读取录音或会议时间线及原文资源 |
| `get_note_quick_note` | 直接读取录音快捷笔记 |
| `get_note_todos` | 读取会议总结中明确待办章节规则解析出的待办；不让模型自由猜测 |
| `save_note` | 新建笔记（纯文本/链接/图片，见下方类型说明） |
| `update_note` | 更新笔记（标题/内容/标签，仅支持 plain_text 类型） |
| `get_note_task_progress` | 查询创建笔记任务进度（链接/图片笔记） |
| `delete_note` | 删除笔记（移入回收站） |
| `add_note_tags` | 添加笔记标签 |
| `delete_note_tag` | 删除笔记标签 |
| `recall` | 全局语义搜索（在所有笔记中搜索） |
| `recall_knowledge` | 知识库语义搜索（在指定知识库中搜索） |
| `list_topics` | 获取知识库列表，默认 DEFAULT，可指定 scope |
| `create_topic` | 创建知识库 |
| `list_topic_notes` | 获取知识库笔记列表 |
| `batch_add_notes_to_topic` | 批量添加笔记到知识库 |
| `remove_note_from_topic` | 从知识库移除笔记 |
| `list_topic_directories` | 浏览知识库文件夹及资源 |
| `create_topic_directory` | 创建知识库文件夹 |
| `update_topic_directory` | 重命名或移动知识库文件夹 |
| `delete_topic_directory` | 删除空知识库文件夹 |
| `get_upload_config` | 获取图片上传配置 |
| `get_upload_token` | 获取图片上传凭证（预签名 URL） |
| `upload_image` | 完整图片上传（自动获取凭证 + 上传到 OSS）|
| `list_topic_bloggers` | 获取知识库订阅的博主列表 |
| `follow_topic_blogger` | 订阅抖音博主到知识库 |
| `list_topic_blogger_contents` | 获取博主内容列表（摘要） |
| `get_blogger_content_detail` | 获取博主内容详情（含原文） |
| `list_topic_lives` | 获取知识库已完成直播列表 |
| `get_live_detail` | 获取直播详情（含 AI 摘要和原文转写） |
| `get_quota` | 查询 API 调用配额 |
| `share_note` | 生成笔记分享链接 |
| `follow_topic_live` | 在知识库里订阅得到直播 |
| `list_subscribe_topics` | 获取真实订阅的他人知识库，默认 DEFAULT，可指定 scope |

## Installation

需要 Node.js 20 或更高版本。

```bash
# 直接运行（推荐，无需克隆）
npx @getnote/mcp

# 或全局安装
npm install -g @getnote/mcp
```

## Usage

### 配置授权

当前本地 MCP 通过 OpenAPI API Key 和 Client ID 鉴权。先在 **https://www.biji.com/openapi** 创建或选择应用，完成账号授权并生成 API Key，再把两项凭证配置给 MCP 客户端。不要把凭证写进会提交到仓库的配置文件。

### Environment variable

```bash
# 临时使用
GETNOTE_API_KEY=your_api_key GETNOTE_CLIENT_ID=your_client_id node dist/index.js

# 持久化（添加到 ~/.zshrc 或 ~/.bashrc）
export GETNOTE_API_KEY=gk_live_xxx
export GETNOTE_CLIENT_ID=cli_xxx
# 可选：仅在明确联调测试环境时覆盖
export GETNOTE_API_URL=http://entree.dev.didatrip.com
```

### CLI flag

```bash
node dist/index.js --api-key your_api_key --client-id your_client_id
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
        "GETNOTE_API_KEY": "your_api_key_here",
        "GETNOTE_CLIENT_ID": "your_client_id_here"
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

> **语音笔记等其他类型**只能在 得到大脑（Get笔记） App 或 Web 端创建，MCP 可以读取但无法创建。

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
  -F "key=${object_key}" \
  -F "OSSAccessKeyId=${accessid}" \
  -F "policy=${policy}" \
  -F "signature=${signature}" \
  -F "callback=${callback}" \
  -F "Content-Type=${oss_content_type}" \
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

> **推荐流程**：直接使用 `upload_image` 工具，它会自动完成步骤 1 和 2 并返回 `image_url`。`image_path` 仅接受相对路径；也可以传 `image_base64`，避免 MCP 读取超出工作目录的本地文件。

## API

- **Base URL**: `https://openapi.biji.com/open/api/v1`
- **Auth**: Bearer Token (API Key)

Get your API Key and Client ID at [得到大脑（Get笔记）开放平台](https://www.biji.com/openapi).

### 新版契约兼容

- 所有雪花 ID 优先传十进制字符串。为兼容历史调用，工具仍接受 JavaScript 安全整数；超过 `Number.MAX_SAFE_INTEGER` 的数字会被拒绝，避免静默精度损失。
- `save_note` 支持 `topic_id`、`parent_id`、`client_request_id`。重试同一创建请求时复用同一个 `client_request_id`。
- `list_topics` 和 `list_subscribe_topics` 默认只返回 `DEFAULT`；需要书籍、客户档案或团队知识库时，显式传 `BOOKSPACE`、`CUSTOMER` 或 `TEAMSPACE`。订阅列表不包含自己创建的知识库。
- 知识库支持文件夹浏览和管理；`batch_add_notes_to_topic` 可传 `directory_id`，把笔记直接加入目标文件夹。
- 即使 HTTP 为 200，`success:false` 仍按失败处理；错误结果保留 `code/reason/retryable/field/constraint/expected_type/request_id`。
- `GETNOTE_API_URL` 可传站点根地址、`/open` 或完整 `/open/api/v1`；未设置时仍使用生产地址。

## 🚀 进阶用法：用笔记内链实践柳比歇夫时间日志法

柳比歇夫时间日志法的核心是**每天记录自己把时间花在了哪里**，事后统计、复盘、改进。

结合 得到大脑（Get笔记）内链，AI 可以帮你自动串联：

**每天早上**

> 👤 帮我记一条今日工作日志，内链到「产品设计方案」和「客户反馈」这两条笔记
>
> 🤖 已记录「2026-04-24 工作日志」，正文已插入两条内链。

**每周复盘**

> 👤 找找我这周的工作日志，整理一下时间分配
>
> 🤖 找到 5 条日志，你这周：产品设计 12h、客户沟通 6h、开会 4h……

**内链格式**：在笔记正文里用 `https://biji.com/note/{note_id}` 引用其他笔记。示例：

```
参考上次的讨论：https://biji.com/note/1234567890000000001
```

告诉 AI 要内链到哪条笔记，AI 会自动获取对应 note_id 插入。

---

## 🆕 更新日志

| 日期 | 版本 | 新能力 | 适合怎么用 |
|------|------|--------|------------|
| 2026-08-13 | **v1.7.0** | 1. 支持知识库目录浏览、创建、重命名、移动和删除<br>2. 支持将笔记加入指定目录，以及读取和维护已有团队知识库 `TEAMSPACE`<br>3. 支持订阅抖音博主、读取博主内容<br>4. 增加录音原文、链接原文、附件、时间线、快捷笔记和会议待办工具<br>5. 统一雪花 ID、结构化错误和异步任务结果 | 让支持 MCP 的 AI 工具直接整理知识库、归档笔记并读取深层内容；调用失败时保留明确原因和 `request_id`，便于恢复与排查 |
| 2026-04-23 | **v1.3.1** | 1. 笔记内链<br>2. 保存分享链接自动变笔记 | 1. 用内链串联每天的工作日志和项目笔记，实践时间日志法<br>2. 收到别人发来的分享链接直接存入笔记 |
| 2026-04-16 | **v1.3.0** | 1. 生成笔记分享链接<br>2. 知识库订阅得到直播 | 1. 把笔记一键分享给朋友<br>2. 在知识库里订阅得到直播课，直播结束后 AI 摘要自动入库 |
| 2026-03-23 | **v1.2.x** | 获取我订阅的知识库，支持语义搜索 | 开通了某个知识库，可以直接问 AI：「在我订阅的 XXX 知识库里搜一下时间管理」 |
| 2026-03-12 | **v1.2.0** | 查看订阅博主内容、直播摘要和转写原文 | 把别人的知识变成自己可检索的笔记库 |

---

## License

MIT
