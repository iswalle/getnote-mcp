[![MseeP.ai Security Assessment Badge](https://mseep.net/pr/iswalle-getnote-mcp-badge.png)](https://mseep.ai/app/iswalle-getnote-mcp)

# 得到大脑（Get笔记）MCP Server

让支持 MCP 的 AI 工具（Claude Desktop、Cursor 等）直接读写你的得到大脑笔记：搜索、保存、阅读、整理知识库。

## 准备

1. 在 [得到大脑开放平台](https://www.biji.com/openapi) 创建应用，生成 **API Key** 和 **Client ID**
2. 本机装好 Node.js 20 以上

所有得到大脑用户授权后都可以调用，会员享有更高额度（[了解会员](https://www.biji.com/checkout?product_alias=9Ab36BB3ZD&spm=openapi_mcp)）。让 AI 调用 `get_quota` 可以看当前额度。

## 接入 AI 工具

以 Claude Desktop 为例，在 `~/Library/Application Support/Claude/claude_desktop_config.json` 里加上：

```json
{
  "mcpServers": {
    "getnote": {
      "command": "npx",
      "args": ["-y", "@getnote/mcp"],
      "env": {
        "GETNOTE_API_KEY": "你的 API Key",
        "GETNOTE_CLIENT_ID": "你的 Client ID"
      }
    }
  }
}
```

其他工具按各自的 MCP 配置方式填同样的命令和环境变量。也可以用参数传入：`npx @getnote/mcp --api-key <key> --client-id <id>`。

不要把 API Key 写进会提交到代码仓库的文件。

## 能做什么

接好后直接对 AI 说，例如：

- 「帮我记一下：周五前回复王总」
- 「把这个链接存到得到大脑」
- 「搜一下我哪些笔记提到了 RAG」
- 「找出上周录音台的会议笔记，读一下讲到定价的部分」
- 「把这 3 条笔记放进『产品调研』知识库」

| 分类 | 工具 |
| --- | --- |
| 找笔记 | `list_notes`（可按来源、类型、时间筛选）、`search_account_content`、`search_knowledge_base`、`list_reference_resources` |
| 读笔记 | `get_note`、`batch_get_notes`、`get_note_outline`、`read_note_section`、`get_note_original`、`get_note_transcript`、`get_note_attachments`、`get_note_timeline`、`get_note_chapters`、`get_note_marks`、`get_note_quick_note`、`get_note_todos`、`list_sprouts`、`get_sprout` |
| 写笔记 | `save_note`（文字、链接、图片）、`get_note_task_progress`、`update_note`、`delete_note`、`share_note`、`add_note_tags`、`delete_note_tag` |
| 知识库 | `list_knowledge_bases`、`list_subscribed_knowledge_bases`、`list_knowledge_base_notes`、`create_topic`、`batch_add_notes_to_topic`、`remove_note_from_topic`、文件夹的浏览与增删改 |
| 订阅内容 | 抖音博主、得到直播的订阅和内容读取 |
| 上传 | `upload_image`（图片一步上传）、知识库文件上传相关工具 |
| 账号 | `get_quota` |

几点说明：

- 录音台的笔记用 `list_notes` 的 `source=vendor_moan` 查，录音卡用 `getseed`
- 长笔记先用 `get_note_outline` 看目录，再用 `read_note_section` 按段读，不用整篇拉取
- 只能新建文字、链接、图片笔记；录音等类型只能在 App 或网页端创建，这里只能读
- 删除是移入回收站，可以在 App 里恢复
- 笔记 ID 一律按字符串传，避免长数字丢精度
- 每个账号每天最多新建 50 个知识库，北京时间 0 点重置
- 旧工具名（如 `recall`、`list_topics`）仍然可用

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `GETNOTE_API_KEY` | API Key（必填） |
| `GETNOTE_CLIENT_ID` | Client ID（必填） |
| `GETNOTE_API_URL` | 换成别的 API 地址，一般不用设 |

## 更新日志

| 版本 | 日期 | 主要变化 |
| --- | --- | --- |
| v1.12.3 | 2026-11-18 | 文档：说明所有用户都能调用，会员额度更高 |
| v1.12.x | 2026-11-17 | 长笔记按目录分段读；工具改用更好懂的名字，旧名字仍可用；依赖升级到已修复版本 |
| v1.11.0 | 2026-11-04 | 遇到限流自动排队、有限重试；上传中断后能接着传，不重复上传 |
| v1.9.0 | 2026-10-13 | 按书名、作者找书；按引用来源和时间筛选笔记 |
| v1.8.0 | 2026-09-24 | 读取标记、发芽报告和章节时间线；上传文件到知识库 |
| v1.7.0 | 2026-08-13 | 知识库文件夹管理；订阅抖音博主；读取录音原文、附件、时间线和会议待办 |

更早的版本见 [Releases](https://github.com/iswalle/getnote-mcp/releases)。

## License

MIT
