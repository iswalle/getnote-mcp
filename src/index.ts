#!/usr/bin/env node
/**
 * getnote-mcp — MCP server for Get笔记 (GetNotes) Open API
 *
 * Usage:
 *   GETNOTE_API_KEY=your_key GETNOTE_CLIENT_ID=your_client_id node dist/index.js
 *   or pass --api-key and --client-id flags
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { GetNoteClient, GetNoteAPIError, SaveNoteReq, UpdateNoteReq } from "./client.js";
import { OPENAPI_MEMBERSHIP_PURCHASE_URL } from "./membership.js";
import { readFileSync, realpathSync } from "node:fs";
import { join, resolve, isAbsolute, sep } from "node:path";

const pkg = JSON.parse(
  readFileSync(join(__dirname, "..", "package.json"), "utf-8")
) as { version: string };
const SERVER_VERSION: string = pkg.version;

// ─── Security ────────────────────────────────────────────────────────────────

/**
 * 校验并解析 upload_image 的 image_path，防止路径穿越（安全漏洞 #10）。
 *
 * 为什么要校验：upload_image 会把 image_path 指向的本地文件读出来并上传到公网
 * CDN。如果不校验，攻击者只要能发起 MCP 调用，就能传入任意路径
 * （如 "/etc/passwd"、"../../.ssh/id_rsa"），把宿主机上的任意敏感文件读出来
 * 并外泄到 CDN —— 等同于任意文件读取漏洞。
 *
 * 校验策略：
 *  - 拒绝 null byte：底层 syscall 会在 \0 处截断字符串，可绕过后续校验。
 *  - 拒绝绝对路径（以 / 或 \ 开头，或平台判定为绝对路径）。
 *  - 拒绝包含 ".." 的路径段：避免跳出工作目录 / 允许目录。
 *  - 用 realpathSync + resolve 解开符号链接，确保最终真实路径严格位于允许
 *    目录内（防止软链逃逸）。未设置 GETNOTE_MCP_ALLOWED_ROOT 时，默认使用
 *    当前工作目录作为允许目录。
 *
 * @returns 经校验、可安全读取的最终路径。
 */
function resolveSafeImagePath(imagePath: string): string {
  if (typeof imagePath !== "string" || imagePath.length === 0) {
    throw new Error("image_path must be a non-empty string");
  }
  // null byte 会截断底层路径字符串，从而绕过后续的字符串校验
  if (imagePath.includes("\0")) {
    throw new Error("image_path must not contain null bytes");
  }
  // 绝对路径直接拒绝（覆盖 POSIX 的 "/"、Windows 的 "\" 与盘符）
  if (isAbsolute(imagePath) || /^[/\\]/.test(imagePath)) {
    throw new Error(
      "image_path must be a relative path; absolute paths are not allowed"
    );
  }
  // 任意 ".." 路径段都可能用来跳出允许目录
  if (imagePath.split(/[/\\]/).includes("..")) {
    throw new Error('image_path must not contain ".." path segments');
  }

  const allowedRoot = process.env.GETNOTE_MCP_ALLOWED_ROOT || process.cwd();
  const rootReal = realpathSync(resolve(allowedRoot));
  const target = realpathSync(resolve(rootReal, imagePath));
  if (target !== rootReal && !target.startsWith(rootReal + sep)) {
    throw new Error("image_path resolves outside of the allowed root");
  }
  return target;
}

// ─── Config ──────────────────────────────────────────────────────────────────

function getApiKey(): string {
  // 1. --api-key flag
  const flagIdx = process.argv.indexOf("--api-key");
  if (flagIdx !== -1 && process.argv[flagIdx + 1]) {
    return process.argv[flagIdx + 1];
  }
  // 2. environment variable
  const envKey = process.env.GETNOTE_API_KEY;
  if (envKey) return envKey;

  console.error(
    "Error: API key required. Set GETNOTE_API_KEY env var or pass --api-key <key>"
  );
  process.exit(1);
}

function getClientId(): string {
  // 1. --client-id flag
  const flagIdx = process.argv.indexOf("--client-id");
  if (flagIdx !== -1 && process.argv[flagIdx + 1]) {
    return process.argv[flagIdx + 1];
  }
  // 2. environment variable
  const envKey = process.env.GETNOTE_CLIENT_ID;
  if (envKey) return envKey;

  console.error(
    "Error: Client ID required. Set GETNOTE_CLIENT_ID env var or pass --client-id <id>"
  );
  process.exit(1);
}

function snowflakeID(value: unknown, field: string): string | number {
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return value;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  throw new Error(
    `${field} must be a decimal string; only legacy integers within JavaScript's safe range are accepted`
  );
}

// ─── Tool Definitions ────────────────────────────────────────────────────────

const TOOLS: Tool[] = [
  // ── Notes ──
  {
    name: "list_notes",
    description:
      "获取笔记列表（每次固定返回 20 条，服务端不支持 limit 参数）。用游标翻页：首次请求不传 cursor；后续把上一次响应返回的 cursor 字段原样传入，直到 has_more 为 false。响应里的 total 是全库笔记总数，不是本页条数。",
    inputSchema: {
      type: "object" as const,
      properties: {
        cursor: {
          type: "string",
          description: "翻页游标。首次不传；后续将上一次响应的 cursor 字段原样传入即可，无需任何转换。",
        },
      },
      required: [],
    },
  },
  {
    name: "get_note",
    description: "获取指定笔记的详细内容，包括正文、标签、附件、音频转录、网页链接等。\n\n**字段语义说明（AI Agent 重要参考）**：\n`content` 通常是 AI 总结，不一定是原文。不同类型笔记的原文字段如下：\n- 普通文字笔记（plain_text）：原文 = `note.content`\n- 链接/网页笔记（link）：原文 = `note.web_page.content`，AI 总结 = `note.content`\n- 录音笔记（audio/local_audio 等）：转写原文 = `note.audio.original`，AI 总结 = `note.content`\n\n用户要求'读原文'时，先看 `note.note_type`，再按上述对应关系取字段。",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: ["string", "number"],
          description: "笔记 ID。必须优先传十进制字符串；仅为兼容旧调用接受 JavaScript 安全整数",
        },
        image_quality: {
          type: "string",
          enum: ["original"],
          description: "图片质量。传 'original' 返回正文中图片的原图链接（无压缩）",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "get_note_original",
    description: "直接读取笔记原文。链接笔记返回网页原文，录音笔记返回转写原文，文字笔记返回正文；不要把 AI 摘要冒充原文。",
    inputSchema: { type: "object" as const, properties: { id: { type: ["string", "number"], description: "笔记 ID，推荐十进制字符串" } }, required: ["id"] },
  },
  {
    name: "get_note_transcript",
    description: "直接读取录音、会议或课堂笔记的转写原文；没有转写时明确返回不可用。",
    inputSchema: { type: "object" as const, properties: { id: { type: ["string", "number"], description: "笔记 ID，推荐十进制字符串" } }, required: ["id"] },
  },
  {
    name: "get_note_attachments",
    description: "直接列出笔记中的图片、音频和文件附件，不需要从完整详情中猜字段。",
    inputSchema: { type: "object" as const, properties: { id: { type: ["string", "number"], description: "笔记 ID，推荐十进制字符串" } }, required: ["id"] },
  },
  {
    name: "get_note_timeline",
    description: "直接读取录音或会议笔记的结构化时间线和原文资源；没有时间线时明确返回不可用。",
    inputSchema: { type: "object" as const, properties: { id: { type: ["string", "number"], description: "笔记 ID，推荐十进制字符串" } }, required: ["id"] },
  },
  {
    name: "get_note_chapters",
    description: "读取总结中的独立章节时间线 chapter_timeline；start_ms 为毫秒，保留 source。与录音 moments 和标记分别读取，不能相互替代。",
    inputSchema: { type: "object" as const, properties: { id: { type: "string", description: "笔记 ID" } }, required: ["id"] },
  },
  {
    name: "get_note_quick_note",
    description: "直接读取录音笔记的快捷笔记；没有快捷笔记时明确返回不可用。",
    inputSchema: { type: "object" as const, properties: { id: { type: ["string", "number"], description: "笔记 ID，推荐十进制字符串" } }, required: ["id"] },
  },
  {
    name: "get_note_todos",
    description: "读取从会议总结中明确的待办章节按规则解析出的条目。返回 source 和 items；空列表表示未识别到明确待办章节，不应让模型自由补写。",
    inputSchema: { type: "object" as const, properties: { id: { type: ["string", "number"], description: "笔记 ID，推荐十进制字符串" } }, required: ["id"] },
  },
  {
    name: "save_note",
    description:
      "新建笔记（⚠️ 仅支持新建，不支持编辑已有笔记）。支持纯文本笔记（plain_text）、链接笔记（link）和图片笔记（img_text）。\n\n🔗 **笔记内链**：Get笔记正文支持链接到其他笔记，格式为 `https://biji.com/note/{note_id}`。如需在笔记正文中引用其他笔记，按此格式填写 content 中的链接。若当前笔记后续会被分享出去，则应优先调用 `share_note` 工具获取被引用笔记的分享链接，并以分享链接替代内链写入正文。\n\n**图片笔记流程**：先用 upload_image 上传图片获取 image_url，再调用此接口传入 image_urls。\n\n**返回值说明**：\n- `plain_text`：同步返回 `id`、`title`、`created_at`、`updated_at`。\n- `link`（分享链接：`biji.com/note/share_note/*` 或 `d.biji.com/*` 短链）：同步返回 `id`、`title`、`created_at`、`updated_at`，**无需轮询**。\n- `link`（普通链接）：返回 `tasks` 数组（每项含 `task_id` 和 `url`），需用 `get_note_task_progress` 轮询进度。",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: {
          type: "string",
          description: "笔记标题",
        },
        content: {
          type: "string",
          description: "笔记正文（Markdown 格式）。链接笔记不需要此字段",
        },
        note_type: {
          type: "string",
          enum: ["plain_text", "link", "img_text"],
          description: "笔记类型：plain_text（纯文本，默认）、link（链接笔记）、img_text（图片笔记）",
          default: "plain_text",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "标签列表（最多 5 个，每个不超过 10 个汉字）",
        },
        parent_id: {
          type: ["string", "number"],
          description: "父笔记 ID（优先传十进制字符串；创建子笔记时填，父笔记的 is_child_note 必须为 false）",
        },
        topic_id: {
          type: "string",
          description: "目标知识库 ID（来自 list_topics；支持 DEFAULT、BOOKSPACE、CUSTOMER、TEAMSPACE）",
        },
        client_request_id: {
          type: "string",
          description: "可选幂等键（1-128 个 ASCII 字符）。重试同一创建请求时必须复用同一个值",
        },
        link_url: {
          type: "string",
          description: "链接 URL（note_type=link 时必填）。分享链接（biji.com/note/share_note/* 或 d.biji.com/* 短链）同步返回笔记 ID；普通链接异步处理需轮询",
        },
        image_urls: {
          type: "array",
          items: { type: "string" },
          description: "图片 URL 列表（note_type=img_text 时必填）",
        },
      },
      required: [],
    },
  },
  {
    name: "get_note_task_progress",
    description:
      "查询创建笔记任务的处理进度。用于链接笔记（note_type=link）创建后，通过 save_note 返回的 task_id 轮询任务状态，直到 status 变为 success（可获取 note_id）或 failed（可获取 error_msg）。建议每 10~30 秒轮询一次，约 3 分钟内完成。需要 note.content.read scope。",
    inputSchema: {
      type: "object" as const,
      properties: {
        task_id: {
          type: "string",
          description: "任务 ID（创建链接笔记时 save_note 返回的 tasks[].task_id）",
        },
      },
      required: ["task_id"],
    },
  },
  {
    name: "delete_note",
    description: "删除笔记（移入回收站）。需要 note.content.trash scope。",
    inputSchema: {
      type: "object" as const,
      properties: {
        note_id: {
          type: ["string", "number"],
          description: "笔记 ID。必须优先传十进制字符串；仅兼容 JavaScript 安全整数",
        },
      },
      required: ["note_id"],
    },
  },
  {
    name: "update_note",
    description:
      "更新已有笔记的标题、内容或标签。⚠️ 仅支持 plain_text 类型笔记，链接笔记、图片笔记等暂不支持更新。至少需要传 title、content、tags 中的一个。tags 是替换操作，会覆盖原有标签。",
    inputSchema: {
      type: "object" as const,
      properties: {
        note_id: {
          type: ["string", "number"],
          description: "笔记 ID（必填，优先传十进制字符串）",
        },
        title: {
          type: "string",
          description: "新标题（可选，不传则不更新）",
        },
        content: {
          type: "string",
          description: "新内容，Markdown 格式（可选，不传则不更新）",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "新标签列表（可选，不传则保持原标签；传则替换原有标签）",
        },
      },
      required: ["note_id"],
    },
  },

  // ── Tags ──
  {
    name: "add_note_tags",
    description: "为指定笔记添加标签。",
    inputSchema: {
      type: "object" as const,
      properties: {
        note_id: {
          type: ["string", "number"],
          description: "笔记 ID（优先传十进制字符串）",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "要添加的标签名称列表",
        },
      },
      required: ["note_id", "tags"],
    },
  },
  {
    name: "delete_note_tag",
    description: "删除笔记的指定标签（系统标签不可删除）。",
    inputSchema: {
      type: "object" as const,
      properties: {
        note_id: {
          type: ["string", "number"],
          description: "笔记 ID（优先传十进制字符串）",
        },
        tag_id: {
          type: "string",
          description: "要删除的标签 ID（来自 add_note_tags 返回或 get_note 的 tags[].id 字段）",
        },
      },
      required: ["note_id", "tag_id"],
    },
  },

  // ── Knowledge / Topics ──
  {
    name: "list_topics",
    description: "获取用户创建、拥有或加入的知识库列表。默认只返回普通知识库（DEFAULT）；可用 scope 指定客户档案、书籍或团队知识库。返回 topics[]、has_more、total。",
    inputSchema: {
      type: "object" as const,
      properties: {
        page: {
          type: "number",
          description: "页码，从 1 开始（默认 1）",
          default: 1,
        },
        scope: {
          type: "string",
          enum: ["DEFAULT", "CUSTOMER", "BOOKSPACE", "TEAMSPACE"],
          description: "知识库类型，默认 DEFAULT",
          default: "DEFAULT",
        },
      },
      required: [],
    },
  },
  {
    name: "create_topic",
    description: "创建新的知识库。⚠️ 限制：每天最多创建 50 个知识库，北京时间自然日 00:00 重置。",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "知识库名称（必填）",
        },
        description: {
          type: "string",
          description: "知识库描述（可选）",
        },
        cover: {
          type: "string",
          description: "封面图片 URL（可选）",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "list_topic_notes",
    description: "获取指定知识库内的笔记列表（每页 20 条）。\n\n**AI Agent 提示**：列表返回的 `content` 字段可能较长且通常为 AI 总结。如需先获取标题和类型再按需读详情，可用此接口获取 `note_id` 列表，再对感兴趣的条目逐一调用 `get_note`。",
    inputSchema: {
      type: "object" as const,
      properties: {
        topic_id: {
          type: "string",
          description: "知识库 ID",
        },
        page: {
          type: "number",
          description: "页码，从 1 开始（默认 1）",
          default: 1,
        },
      },
      required: ["topic_id"],
    },
  },
  {
    name: "batch_add_notes_to_topic",
    description: "批量将笔记添加到知识库（每批最多 20 个）。",
    inputSchema: {
      type: "object" as const,
      properties: {
        topic_id: {
          type: "string",
          description: "知识库 ID",
        },
        note_ids: {
          type: "array",
          items: { type: "string" },
          description: "笔记 ID 列表（字符串格式，最多 20 个）",
        },
        directory_id: {
          type: "string",
          description: "目标目录 ID；不传则加入知识库根目录",
        },
      },
      required: ["topic_id", "note_ids"],
    },
  },
  {
    name: "list_topic_directories",
    description: "浏览知识库文件夹结构及当前目录下的笔记等资源。支持个人、书籍、客户档案和团队知识库。",
    inputSchema: { type: "object" as const, properties: {
      topic_id: { type: "string", description: "知识库 ID" },
      directory_id: { type: "string", description: "目录 ID；不传表示根目录" },
    }, required: ["topic_id"] },
  },
  {
    name: "create_topic_directory",
    description: "在知识库中创建文件夹。",
    inputSchema: { type: "object" as const, properties: {
      topic_id: { type: "string", description: "知识库 ID" }, name: { type: "string", description: "文件夹名称" },
      parent_id: { type: "string", description: "父目录 ID；不传表示根目录" },
    }, required: ["topic_id", "name"] },
  },
  {
    name: "update_topic_directory",
    description: "重命名或移动知识库文件夹。未提供的字段保持不变。",
    inputSchema: { type: "object" as const, properties: {
      topic_id: { type: "string" }, directory_id: { type: "string" }, name: { type: "string" }, parent_id: { type: "string" },
    }, required: ["topic_id", "directory_id"] },
  },
  {
    name: "delete_topic_directory",
    description: "删除空的知识库文件夹。属于破坏性操作，调用前必须取得用户确认。",
    inputSchema: { type: "object" as const, properties: {
      topic_id: { type: "string" }, directory_id: { type: "string" },
    }, required: ["topic_id", "directory_id"] },
  },
  {
    name: "remove_note_from_topic",
    description: "将笔记从知识库中移除。",
    inputSchema: {
      type: "object" as const,
      properties: {
        topic_id: {
          type: "string",
          description: "知识库 ID",
        },
        note_ids: {
          type: "array",
          items: { type: "string" },
          description: "笔记 ID 列表（字符串格式）",
        },
      },
      required: ["topic_id", "note_ids"],
    },
  },

  {
    name: "get_note_marks",
    description: "读取笔记标记（包含文字标记、照片等），与 Timeline 独立，不用时间线替代标记。",
    inputSchema: { type: "object", properties: { note_id: { type: "string" } }, required: ["note_id"] },
  },
  {
    name: "list_sprouts",
    description: "按月份读取当前用户发芽报告；发芽不是标记数据。",
    inputSchema: { type: "object", properties: { month: { type: "string", description: "YYYY-MM" }, since_id: { type: "string", description: "上一页返回的游标，原样传递" }, limit: {type: "integer", minimum: 1, maximum: 20} }, required: ["month"] },
  },
  {
    name: "get_sprout",
    description: "读取已授权用户发芽报告原文，id 来自 list_sprouts。",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "get_knowledge_file_capabilities",
    description: "上传前查询当前配置允许的文件扩展名、MIME、大小、页数和独立日限额；不缓存为固定格式列表。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_knowledge_file_upload_token",
    description: "获取一次 OSS 文件上传临时凭据。通过本地 getnote upload --token-file <file> --max-size-bytes <能力上限> 直接 PUT 到 OSS，无需再次 CLI 登录。凭据通过受控文件或 stdin 传入，不写命令参数或聊天；不要把文件字节传给云 MCP。",
    inputSchema: { type: "object", properties: { mime_type: { type: "string", description: "能力接口返回的扩展名，如 HTML" } }, required: ["mime_type"] },
  },
  {
    name: "upload_knowledge_file",
    description: "OSS 直传成功后将原文件加入知识库，只接收元数据，不接收本地路径或 base64。返回处理中的资源不等于入库成功；用 list_topic_directories 查询同一 ID，直到 SUCCESS 或 FAIL。",
    inputSchema: { type: "object", additionalProperties: false, properties: { topic_id: { type: "string" }, directory_id: { type: "string" }, file_name: { type: "string" }, file_type: { type: "string" }, md5: { type: "string" }, url: { type: "string" } }, required: ["topic_id", "directory_id", "file_name", "file_type", "md5", "url"] },
  },
  // ── Image ──
  {
    name: "get_upload_config",
    description:
      "获取图片上传配置，包括支持的文件类型、大小限制等。上传图片前先调用此接口了解约束。",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "get_upload_token",
    description:
      "获取 OSS 图片上传凭证。返回 accessid/host/policy/signature 等字段，用于 multipart/form-data POST 上传图片到阿里云 OSS。上传成功后获取 image_id，再用 save_note 创建图片笔记。⚠️ mime_type 必须与实际文件格式一致，否则 OSS 签名失败。",
    inputSchema: {
      type: "object" as const,
      properties: {
        mime_type: {
          type: "string",
          enum: ["jpg", "png", "gif", "webp", "jpeg"],
          description: "图片类型：jpg | png | gif | webp，默认 png",
        },
        count: {
          type: "number",
          description: "需要的 token 数量，默认 1，最大 9（批量上传时使用）",
          default: 1,
        },
      },
      required: [],
    },
  },
  {
    name: "upload_image",
    description:
      "上传图片到 OSS。返回 image_url（用于创建图片笔记的 image_urls 参数）。",
    inputSchema: {
      type: "object" as const,
      properties: {
        image_path: {
          type: "string",
          description:
            "本地图片文件路径。出于安全考虑仅接受相对路径：不允许绝对路径（以 / 或 \\ 开头）、不允许包含 \"..\" 的路径段、不允许 null byte。默认限制在当前工作目录内；若设置了环境变量 GETNOTE_MCP_ALLOWED_ROOT，则限制在指定目录内。符号链接解析后也不得离开该目录。",
        },
        image_base64: {
          type: "string",
          description: "图片的 Base64 编码数据（与 image_path 二选一）",
        },
        mime_type: {
          type: "string",
          description: "图片类型（如 png、jpg、jpeg），默认 png",
          default: "png",
        },
      },
      required: [],
    },
  },

  // ── Knowledge / Bloggers ──
  {
    name: "list_topic_bloggers",
    description:
      "获取知识库订阅的博主列表。需要 topic.blogger.read scope。",
    inputSchema: {
      type: "object" as const,
      properties: {
        topic_id: {
          type: "string",
          description: "知识库 ID（来自 list_topics 的 topic_id 字段）",
        },
        page: {
          type: "number",
          description: "页码，从 1 开始，默认 1",
        },
      },
      required: ["topic_id"],
    },
  },
  {
    name: "follow_topic_blogger",
    description: "把抖音博主订阅到指定知识库，后续可读取该博主内容。",
    inputSchema: { type: "object" as const, properties: {
      topic_id: { type: "string", description: "知识库 ID" }, link: { type: "string", description: "抖音博主主页或分享链接" },
      platform: { type: "string", enum: ["douyin"], default: "douyin" },
    }, required: ["topic_id", "link"] },
  },
  {
    name: "list_topic_blogger_contents",
    description:
      "获取知识库中某个博主发布的内容列表（摘要，不含原文）。需要 topic.blogger.read scope。",
    inputSchema: {
      type: "object" as const,
      properties: {
        topic_id: {
          type: "string",
          description: "知识库 ID（来自 list_topics 的 topic_id 字段）",
        },
        follow_id: {
          type: ["string", "number"],
          description: "博主订阅 ID（优先使用 list_topic_bloggers 返回的 follow_id_str；兼容安全整数 follow_id）",
        },
        page: {
          type: "number",
          description: "页码，从 1 开始，默认 1",
        },
      },
      required: ["topic_id", "follow_id"],
    },
  },
  {
    name: "get_blogger_content_detail",
    description:
      "获取博主内容详情，包含完整原文（post_media_text）。需要 topic.blogger.read scope。",
    inputSchema: {
      type: "object" as const,
      properties: {
        topic_id: {
          type: "string",
          description: "知识库 ID（来自 list_topics 的 topic_id 字段）",
        },
        post_id: {
          type: "string",
          description: "内容 ID（来自 list_topic_blogger_contents 的 post_id_alias 字段）",
        },
      },
      required: ["topic_id", "post_id"],
    },
  },

  // ── Knowledge / Lives ──
  {
    name: "list_topic_lives",
    description:
      "获取知识库中已完成且 AI 已处理的直播列表。需要 topic.live.read scope。",
    inputSchema: {
      type: "object" as const,
      properties: {
        topic_id: {
          type: "string",
          description: "知识库 ID（来自 list_topics 的 topic_id 字段）",
        },
        page: {
          type: "number",
          description: "页码，从 1 开始，默认 1",
        },
      },
      required: ["topic_id"],
    },
  },
  {
    name: "get_live_detail",
    description:
      "获取直播详情，包含 AI 摘要（post_summary）和完整原文转写（post_media_text）。需要 topic.live.read scope。",
    inputSchema: {
      type: "object" as const,
      properties: {
        topic_id: {
          type: "string",
          description: "知识库 ID（来自 list_topics 的 topic_id 字段）",
        },
        live_id: {
          type: ["string", "number"],
          description: "直播 ID（来自 list_topic_lives 的 live_id，优先按字符串原样传入）",
        },
      },
      required: ["topic_id", "live_id"],
    },
  },

  {
    name: "follow_topic_live",
    description:
      "订阅一个得到 App 直播到知识库。直播结束后经 AI 处理即可通过 list_topic_lives 查看。目前仅支持得到 App 直播链接。需要 topic.live.write scope。",
    inputSchema: {
      type: "object" as const,
      properties: {
        topic_id: {
          type: "string",
          description: "知识库 ID",
        },
        link: {
          type: "string",
          description: "得到 App 直播链接（目前仅支持得到）",
        },
      },
      required: ["topic_id", "link"],
    },
  },

  // ── Note / Sharing ──
  {
    name: "share_note",
    description:
      "生成笔记的公开分享链接。幂等接口，多次调用返回同一个 share_url。需要 note.sharing.write scope。",
    inputSchema: {
      type: "object" as const,
      properties: {
        note_id: {
          type: "string",
          description: "笔记 ID（字符串格式）",
        },
        share_exclude_audio: {
          type: "boolean",
          description: "是否排除音频内容，默认 false",
        },
      },
      required: ["note_id"],
    },
  },

  // ── Knowledge / Subscribe ──
  {
    name: "list_subscribe_topics",
    description:
      "获取当前用户真实订阅的他人知识库列表，不包含自己创建的知识库。默认只返回 DEFAULT；可用 scope 指定其他类型。返回 topics[]、has_more、total。",
    inputSchema: {
      type: "object" as const,
      properties: {
        page: {
          type: "number",
          description: "页码，从 1 开始，默认 1",
        },
        scope: {
          type: "string",
          enum: ["DEFAULT", "CUSTOMER", "BOOKSPACE", "TEAMSPACE"],
          description: "知识库类型，默认 DEFAULT",
          default: "DEFAULT",
        },
      },
      required: [],
    },
  },

  // ── Quota ──
  {
    name: "get_quota",
    description:
      "查询当前 API Key 的调用配额，包括 read/write/write_note 三类的日/月剩余次数。",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },

  // ── Recall / Search ──
  {
    name: "recall",
    description:
      "全局语义搜索：在所有笔记中进行语义召回。适用场景：「搜一下」「找找我哪些笔记提到了 XX」。返回结果按相关度从高到低排序。需要 note.recall.read scope。",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "搜索关键词或语义描述（必填）",
        },
        top_k: {
          type: "number",
          description: "返回数量，默认 3，最大 10",
          default: 3,
        },
      },
      required: ["query"],
    },
  },
  {
    name: "recall_knowledge",
    description:
      "知识库语义搜索：在指定知识库范围内进行语义召回。适用场景：「在我的 XX 知识库搜一下 XX」。返回结果按相关度从高到低排序。需要 note.topic.recall.read scope。",
    inputSchema: {
      type: "object" as const,
      properties: {
        topic_id: {
          type: "string",
          description: "知识库 ID（来自 list_topics 的 topic_id 字段）（必填）",
        },
        query: {
          type: "string",
          description: "搜索关键词或语义描述（必填）",
        },
        top_k: {
          type: "number",
          description: "返回数量，默认 3，最大 10",
          default: 3,
        },
      },
      required: ["topic_id", "query"],
    },
  },
];

// ─── Tool Handlers ───────────────────────────────────────────────────────────

type ToolInput = Record<string, unknown>;

async function handleTool(
  name: string,
  input: ToolInput,
  client: GetNoteClient
): Promise<unknown> {
  switch (name) {
    // ── Notes ──
    case "list_notes": {
      const cursor = (input.cursor as string | undefined);
      return client.listNotes({ cursor: cursor === "0" ? undefined : cursor });
    }
    case "get_note": {
      return client.getNote(snowflakeID(input.id, "id"), input.image_quality as string | undefined);
    }
    case "get_note_original": {
      const result = await client.getNote(snowflakeID(input.id, "id"));
      const note = result.note;
      const original = note.web_page?.content || note.audio?.original || note.content;
      if (!original) throw new Error("Original content is not available for this note");
      return { id: note.id, note_type: note.note_type, title: note.title, original };
    }
    case "get_note_transcript": {
      const result = await client.getNote(snowflakeID(input.id, "id"));
      const transcript = result.note.audio?.original;
      if (!transcript) throw new Error("Audio transcript is not available for this note");
      return { id: result.note.id, title: result.note.title, transcript };
    }
    case "get_note_attachments": {
      const result = await client.getNote(snowflakeID(input.id, "id"), "original");
      return { id: result.note.id, title: result.note.title, attachments: result.note.attachments || [] };
    }
    case "get_note_timeline": {
      const result = await client.getNote(snowflakeID(input.id, "id"));
      if (!result.note.timeline) throw new Error("Timeline is not available for this note");
      return { id: result.note.id, title: result.note.title, timeline: result.note.timeline };
    }
    case "get_note_quick_note": {
      const result = await client.getNote(snowflakeID(input.id, "id"));
      if (!result.note.quick_note) throw new Error("Quick note is not available for this note");
      return { id: result.note.id, title: result.note.title, quick_note: result.note.quick_note };
    }
    case "get_note_chapters": {
      const result = await client.getNote(snowflakeID(input.id, "id"));
      if (!result.note.chapter_timeline) throw new Error("Chapter timeline is not available for this note");
      return { id: result.note.id, title: result.note.title, chapter_timeline: result.note.chapter_timeline };
    }
    case "get_note_todos": {
      const result = await client.getNote(snowflakeID(input.id, "id"));
      return {
        id: result.note.id,
        title: result.note.title,
        meeting_todos: result.note.meeting_todos || { source: "summary_markdown_rules", items: [] },
      };
    }
    case "save_note": {
      const body: SaveNoteReq = {};
      if (input.title !== undefined) body.title = input.title as string;
      if (input.content !== undefined) body.content = input.content as string;
      if (input.note_type !== undefined)
        body.note_type = input.note_type as SaveNoteReq["note_type"];
      if (input.tags !== undefined) body.tags = input.tags as string[];
      if (input.parent_id !== undefined)
        body.parent_id = snowflakeID(input.parent_id, "parent_id");
      if (input.topic_id !== undefined) body.topic_id = input.topic_id as string;
      if (input.client_request_id !== undefined)
        body.client_request_id = input.client_request_id as string;
      if (input.link_url !== undefined) body.link_url = input.link_url as string;
      if (input.image_urls !== undefined)
        body.image_urls = input.image_urls as string[];
      return client.saveNote(body);
    }
    case "delete_note": {
      return client.deleteNote(snowflakeID(input.note_id, "note_id"));
    }
    case "update_note": {
      const body: { note_id: number | string; title?: string; content?: string; tags?: string[] } = {
        note_id: snowflakeID(input.note_id, "note_id"),
      };
      if (input.title !== undefined) body.title = input.title as string;
      if (input.content !== undefined) body.content = input.content as string;
      if (input.tags !== undefined) body.tags = input.tags as string[];
      return client.updateNote(body);
    }
    case "get_note_task_progress": {
      return client.getNoteTaskProgress(input.task_id as string);
    }

    // ── Tags ──
    case "add_note_tags": {
      return client.addNoteTags(
        snowflakeID(input.note_id, "note_id"),
        input.tags as string[]
      );
    }
    case "delete_note_tag": {
      return client.deleteNoteTag(
        snowflakeID(input.note_id, "note_id"),
        input.tag_id as string
      );
    }

    // ── Knowledge ──
    case "list_topics": {
      return client.listTopics({
        page: input.page as number | undefined,
        scope: input.scope as "DEFAULT" | "CUSTOMER" | "BOOKSPACE" | "TEAMSPACE" | undefined,
      });
    }
    case "create_topic": {
      return client.createTopic({
        name: input.name as string,
        description: input.description as string | undefined,
        cover: input.cover as string | undefined,
      });
    }
    case "list_topic_notes": {
      return client.listTopicNotes({
        topic_id: input.topic_id as string,
        page: input.page as number | undefined,
      });
    }
    case "batch_add_notes_to_topic": {
      return client.batchAddNotesToTopic({
        topic_id: input.topic_id as string,
        directory_id: input.directory_id as string | undefined,
        note_ids: (input.note_ids as unknown[]).map((id) => String(snowflakeID(id, "note_ids[]"))),
      });
    }
    case "list_topic_directories": {
      return client.listTopicDirectories({ topic_id: input.topic_id as string, directory_id: input.directory_id as string | undefined });
    }
    case "create_topic_directory": {
      return client.createTopicDirectory({ topic_id: input.topic_id as string, name: input.name as string, parent_id: input.parent_id as string | undefined });
    }
    case "update_topic_directory": {
      return client.updateTopicDirectory({ topic_id: input.topic_id as string, directory_id: input.directory_id as string, name: input.name as string | undefined, parent_id: input.parent_id as string | undefined });
    }
    case "delete_topic_directory": {
      return client.deleteTopicDirectory({ topic_id: input.topic_id as string, directory_id: input.directory_id as string });
    }
    case "remove_note_from_topic": {
      return client.removeNoteFromTopic({
        topic_id: input.topic_id as string,
        note_ids: (input.note_ids as unknown[]).map((id) => String(snowflakeID(id, "note_ids[]"))),
      });
    }

    // ── Image ──
    case "get_note_marks": return client.getNoteMarks(String(snowflakeID(input.note_id, "note_id")));
    case "list_sprouts": return client.listSprouts(z.string().regex(/^\d{4}-\d{2}$/).parse(input.month), z.string().optional().parse(input.since_id), z.number().int().min(1).max(20).optional().parse(input.limit));
    case "get_sprout": return client.getSprout(z.string().min(1).parse(input.id));
    case "get_knowledge_file_capabilities": return client.getKnowledgeFileCapabilities();
    case "get_knowledge_file_upload_token": return client.getKnowledgeFileUploadToken(z.string().min(1).parse(input.mime_type));
    case "upload_knowledge_file": return client.uploadKnowledgeFile(z.object({ topic_id:z.string().min(1), directory_id:z.string().regex(/^\d+$/), file_name:z.string().min(1), file_type:z.string().min(1), md5:z.string().regex(/^[a-fA-F0-9]{32}$/), url:z.string().url() }).strict().parse(input));
    case "get_upload_config": {
      return client.getUploadConfig();
    }
    case "get_upload_token": {
      return client.getUploadToken({
        mime_type: input.mime_type as string | undefined,
        count: input.count as number | undefined,
      });
    }
    case "upload_image": {
      const fs = await import("fs");
      let imageData: Buffer;

      if (input.image_path) {
        // 从文件路径读取 —— 先做路径安全校验，防止任意文件读取（漏洞 #10）
        const safePath = resolveSafeImagePath(input.image_path as string);
        imageData = fs.readFileSync(safePath);
      } else if (input.image_base64) {
        // 从 Base64 解码
        imageData = Buffer.from(input.image_base64 as string, "base64");
      } else {
        throw new Error("Either image_path or image_base64 is required");
      }

      // mime_type 传扩展名格式（如 png、jpg）
      const mimeType = (input.mime_type as string) || "png";
      const result = await client.uploadImage(imageData, mimeType);
      return { 
        success: true, 
        image_url: result.access_url,  // 用于创建图片笔记
        image_id: result.image_id      // OSS 回调返回的 ID
      };
    }

    // ── Knowledge / Bloggers ──
    case "list_topic_bloggers": {
      return client.listTopicBloggers({
        topic_id: input.topic_id as string,
        page: input.page as number | undefined,
      });
    }
    case "follow_topic_blogger": {
      return client.followTopicBlogger({ topic_id: input.topic_id as string, link: input.link as string, platform: input.platform as string | undefined });
    }
    case "list_topic_blogger_contents": {
      return client.listTopicBloggerContents({
        topic_id: input.topic_id as string,
        follow_id: snowflakeID(input.follow_id, "follow_id"),
        page: input.page as number | undefined,
      });
    }
    case "get_blogger_content_detail": {
      return client.getBloggerContentDetail({
        topic_id: input.topic_id as string,
        post_id: input.post_id as string,
      });
    }

    // ── Knowledge / Lives ──
    case "list_topic_lives": {
      return client.listTopicLives({
        topic_id: input.topic_id as string,
        page: input.page as number | undefined,
      });
    }
    case "get_live_detail": {
      return client.getLiveDetail({
        topic_id: input.topic_id as string,
        live_id: snowflakeID(input.live_id, "live_id"),
      });
    }

    case "follow_topic_live": {
      return client.followTopicLive({
        topic_id: input.topic_id as string,
        link: input.link as string,
      });
    }

    // ── Note / Sharing ──
    case "share_note": {
      return client.shareNote({
        note_id: input.note_id as string,
        share_exclude_audio: input.share_exclude_audio as boolean | undefined,
      });
    }

    // ── Knowledge / Subscribe ──
    case "list_subscribe_topics": {
      return client.listSubscribeTopics({
        page: input.page as number | undefined,
        scope: input.scope as "DEFAULT" | "CUSTOMER" | "BOOKSPACE" | "TEAMSPACE" | undefined,
      });
    }

    // ── Quota ──
    case "get_quota": {
      return client.getQuota();
    }

    // ── Recall / Search ──
    case "recall": {
      return client.recall({
        query: input.query as string,
        top_k: input.top_k as number | undefined,
      });
    }
    case "recall_knowledge": {
      return client.recallKnowledge({
        topic_id: input.topic_id as string,
        query: input.query as string,
        top_k: input.top_k as number | undefined,
      });
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const apiKey = getApiKey();
  const clientId = getClientId();
  const client = new GetNoteClient(apiKey, clientId);

  const server = new Server(
    {
      name: "getnote-mcp",
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // List tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  // Call tool
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const input = (args ?? {}) as ToolInput;

    try {
      const result = await handleTool(name, input, client);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      if (err instanceof GetNoteAPIError) {
        const errPayload: Record<string, unknown> = {
          error: true,
          code: err.code,
          reason: err.reason,
          message: err.message,
          request_id: err.requestId,
          retryable: err.retryable,
          field: err.field,
          constraint: err.constraint,
          expected_type: err.expectedType,
        };
        if (err.code === 10201) {
          errPayload.membership_url = OPENAPI_MEMBERSHIP_PURCHASE_URL;
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(errPayload, null, 2),
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("getnote-mcp server started");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
