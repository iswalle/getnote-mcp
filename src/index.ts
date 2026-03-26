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

// ─── Tool Definitions ────────────────────────────────────────────────────────

const TOOLS: Tool[] = [
  // ── Notes ──
  {
    name: "list_notes",
    description:
      "获取笔记列表（每次固定返回 20 条）。首次请求 since_id 传 0，后续用上一页最后一条笔记的 ID。",
    inputSchema: {
      type: "object" as const,
      properties: {
        since_id: {
          type: ["number", "string"],
          description: "游标，返回 ID 小于此值的笔记。首次传 0",
          default: 0,
        },
      },
      required: [],
    },
  },
  {
    name: "get_note",
    description: "获取指定笔记的详细内容，包括正文、标签、附件、音频转录、网页链接等。",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: ["number", "string"],
          description: "笔记 ID",
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
    name: "save_note",
    description:
      "新建笔记（⚠️ 仅支持新建，不支持编辑已有笔记）。支持纯文本笔记（plain_text）、链接笔记（link）和图片笔记（img_text）。\n\n**图片笔记流程**：先用 upload_image 上传图片获取 image_url，再调用此接口传入 image_urls。\n\n**返回值说明**：\n- 纯文本/图片笔记：返回 `id`、`title`、`created_at`、`updated_at`。\n- 链接笔记（link）：额外返回 `tasks` 数组（每项含 `task_id` 和 `url`）。链接笔记由 AI 异步处理，可用 `get_note_task_progress` 工具传入 `task_id` 查询处理进度。",
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
          type: ["number", "string"],
          description: "父笔记 ID（创建子笔记时填，父笔记的 is_child_note 必须为 false）",
        },
        link_url: {
          type: "string",
          description: "链接 URL（note_type=link 时必填）",
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
          type: ["number", "string"],
          description: "笔记 ID",
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
          type: ["number", "string"],
          description: "笔记 ID（必填）",
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
          type: ["number", "string"],
          description: "笔记 ID",
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
          type: ["number", "string"],
          description: "笔记 ID",
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
    description: "获取知识库列表（每页固定 20 条）。返回 topics[]、has_more、total。每个 topic 包含 topic_id（知识库 ID，后续所有接口的 topic_id 参数均传此值）、name、description、cover、stats（笔记数、文件数、博主数、直播数）等。",
    inputSchema: {
      type: "object" as const,
      properties: {
        page: {
          type: "number",
          description: "页码，从 1 开始（默认 1）",
          default: 1,
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
    description: "获取指定知识库内的笔记列表（每页 20 条）。",
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
          items: { type: ["number", "string"] },
          description: "笔记 ID 列表（最多 20 个）",
        },
      },
      required: ["topic_id", "note_ids"],
    },
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
          items: { type: ["number", "string"] },
          description: "笔记 ID 列表",
        },
      },
      required: ["topic_id", "note_ids"],
    },
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
          description: "本地图片文件路径",
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
          type: "number",
          description: "博主订阅 ID（来自 list_topic_bloggers 的 follow_id 字段）",
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
          type: "number",
          description: "直播 ID（来自 list_topic_lives 的 live_id 字段）",
        },
      },
      required: ["topic_id", "live_id"],
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
      const since_id = (input.since_id as number | string | undefined) ?? 0;
      return client.listNotes({ since_id });
    }
    case "get_note": {
      return client.getNote(input.id as number | string, input.image_quality as string | undefined);
    }
    case "save_note": {
      const body: SaveNoteReq = {};
      if (input.title !== undefined) body.title = input.title as string;
      if (input.content !== undefined) body.content = input.content as string;
      if (input.note_type !== undefined)
        body.note_type = input.note_type as SaveNoteReq["note_type"];
      if (input.tags !== undefined) body.tags = input.tags as string[];
      if (input.parent_id !== undefined)
        body.parent_id = input.parent_id as number | string;
      if (input.link_url !== undefined) body.link_url = input.link_url as string;
      if (input.image_urls !== undefined)
        body.image_urls = input.image_urls as string[];
      return client.saveNote(body);
    }
    case "delete_note": {
      return client.deleteNote(input.note_id as number | string);
    }
    case "update_note": {
      const body: { note_id: number | string; title?: string; content?: string; tags?: string[] } = {
        note_id: input.note_id as number | string,
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
        input.note_id as number | string,
        input.tags as string[]
      );
    }
    case "delete_note_tag": {
      return client.deleteNoteTag(
        input.note_id as number | string,
        input.tag_id as string
      );
    }

    // ── Knowledge ──
    case "list_topics": {
      return client.listTopics({
        page: input.page as number | undefined,
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
        note_ids: input.note_ids as (number | string)[],
      });
    }
    case "remove_note_from_topic": {
      return client.removeNoteFromTopic({
        topic_id: input.topic_id as string,
        note_ids: input.note_ids as (number | string)[],
      });
    }

    // ── Image ──
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
        // 从文件路径读取
        imageData = fs.readFileSync(input.image_path as string);
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
    case "list_topic_blogger_contents": {
      return client.listTopicBloggerContents({
        topic_id: input.topic_id as string,
        follow_id: input.follow_id as number | string,
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
        live_id: input.live_id as number | string,
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
      version: "1.2.0",
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
        };
        if (err.code === 10201) {
          errPayload.membership_url = "https://www.biji.com/checkout?product_alias=6AydVpYeKl";
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
