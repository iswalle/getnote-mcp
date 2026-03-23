import axios, { AxiosInstance, AxiosError } from "axios";

const BASE_URL = "https://openapi.biji.com/open/api/v1";

export class GetNoteAPIError extends Error {
  constructor(
    public readonly code: number,
    public readonly reason: string,
    message: string,
    public readonly requestId?: string
  ) {
    super(message);
    this.name = "GetNoteAPIError";
  }
}

export class GetNoteClient {
  private http: AxiosInstance;

  constructor(apiKey: string, clientId: string) {
    this.http = axios.create({
      baseURL: BASE_URL,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "X-Client-ID": clientId,
        "Content-Type": "application/json",
      },
      timeout: 30000,
    });

    this.http.interceptors.response.use(
      (res) => res,
      (err: AxiosError) => {
        throw err;
      }
    );
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    params?: Record<string, unknown>,
    data?: unknown
  ): Promise<T> {
    try {
      const res = await this.http.request<{
        success: boolean;
        data: T;
        error?: { code: number; message: string; reason: string };
        request_id?: string;
      }>({
        method,
        url: path,
        params,
        data,
      });

      const body = res.data;
      if (!body.success) {
        const err = body.error;
        throw new GetNoteAPIError(
          err?.code ?? -1,
          err?.reason ?? "unknown",
          err?.message ?? "API request failed",
          body.request_id
        );
      }

      return body.data;
    } catch (err) {
      if (err instanceof GetNoteAPIError) throw err;

      if (axios.isAxiosError(err) && err.response) {
        const body = err.response.data as {
          success?: boolean;
          error?: { code: number; message: string; reason: string };
          request_id?: string;
        };
        if (body?.error) {
          throw new GetNoteAPIError(
            body.error.code,
            body.error.reason,
            body.error.message,
            body.request_id
          );
        }
        throw new Error(`HTTP ${err.response.status}: ${err.message}`);
      }

      throw err;
    }
  }

  // ─── Notes ───────────────────────────────────────────────────────────────

  async listNotes(params: { since_id: number | string }) {
    return this.request<ListNotesResp>("GET", "/resource/note/list", {
      since_id: params.since_id,
    });
  }

  async getNote(id: number | string, image_quality?: string) {
    return this.request<GetNoteResp>("GET", "/resource/note/detail", { id, image_quality });
  }

  async saveNote(body: SaveNoteReq) {
    return this.request<SaveNoteResp>("POST", "/resource/note/save", undefined, body);
  }

  async deleteNote(note_id: number | string) {
    return this.request<DeleteNoteResp>("POST", "/resource/note/delete", undefined, {
      note_id,
    });
  }

  async updateNote(body: UpdateNoteReq) {
    return this.request<UpdateNoteResp>("POST", "/resource/note/update", undefined, body);
  }

  async getNoteTaskProgress(task_id: string) {
    return this.request<NoteTaskProgress>(
      "POST",
      "/resource/note/task/progress",
      undefined,
      { task_id }
    );
  }

  // ─── Tags ────────────────────────────────────────────────────────────────

  async addNoteTags(note_id: number | string, tags: string[]) {
    return this.request<AddNoteTagsResp>(
      "POST",
      "/resource/note/tags/add",
      undefined,
      { note_id, tags }
    );
  }

  async deleteNoteTag(note_id: number | string, tag_id: string) {
    return this.request<DeleteNoteTagResp>(
      "POST",
      "/resource/note/tags/delete",
      undefined,
      { note_id, tag_id }
    );
  }

  // ─── Image ───────────────────────────────────────────────────────────────

  async getUploadConfig() {
    return this.request<GetUploadConfigResp>(
      "GET",
      "/resource/image/config"
    );
  }

  async getUploadToken(params: { count?: number; mime_type?: string }) {
    return this.request<GetUploadTokenResp>(
      "GET",
      "/resource/image/upload_token",
      { count: params.count, mime_type: params.mime_type }
    );
  }

  /**
   * 上传图片到 OSS（使用预签名 URL）
   * @param signUrl 预签名上传 URL（从 getUploadToken 获取的 sign_url）
   * @param token 上传凭证
   * @param imageData 图片数据（Buffer 或 Uint8Array）
   * @returns OSS 回调响应（包含 image_id）
   */
  async uploadImageToOSS(
    token: ImageUploadToken,
    imageData: Buffer | Uint8Array
  ): Promise<{ image_id: string }> {
    // 使用 FormData 构建 multipart 请求
    const FormData = (await import("form-data")).default;
    const form = new FormData();
    
    form.append("OSSAccessKeyId", token.accessid);
    form.append("policy", token.policy);
    form.append("Signature", token.signature);
    form.append("key", token.object_key);
    form.append("callback", token.callback);
    form.append("success_action_status", "200");
    form.append("file", imageData, {
      filename: "image",
      contentType: token.oss_content_type,
    });

    const response = await fetch(token.host, {
      method: "POST",
      body: form as unknown as BodyInit,
      headers: form.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`OSS upload failed: ${response.status}`);
    }

    // 解析回调响应: {"h":{"c":0},"c":{"image":{"id":"xxx"}}}
    const result = await response.json() as { h: { c: number }; c: { image: { id: string } } };
    if (result.h?.c !== 0) {
      throw new Error("OSS callback failed");
    }
    return { image_id: result.c.image.id };
  }

  /**
   * 完整的图片上传流程：获取 token + 上传到 OSS
   * @param imageData 图片数据
   * @param mimeType MIME 类型（如 png, jpg）
   * @returns 上传结果（包含 image_id 和 access_url）
   */
  async uploadImage(
    imageData: Buffer | Uint8Array,
    mimeType: string = "png"
  ): Promise<{ image_id: string; access_url: string }> {
    // 1. 获取上传凭证（现在直接返回单个对象）
    const token = await this.getUploadToken({ mime_type: mimeType });

    // 2. 上传到 OSS
    const { image_id } = await this.uploadImageToOSS(token, imageData);

    // 3. 返回结果
    return { image_id, access_url: token.access_url };
  }

  // ─── Knowledge / Topics ─────────────────────────────────────────────────

  async listTopics(params?: { page?: number; size?: number }) {
    return this.request<ListTopicsResp>("GET", "/resource/knowledge/list", {
      page: params?.page,
      size: params?.size,
    });
  }

  async createTopic(body: { name: string; description?: string; cover?: string }) {
    return this.request<CreateTopicResp>(
      "POST",
      "/resource/knowledge/create",
      undefined,
      body
    );
  }

  async listTopicNotes(params: { topic_id: string; page?: number }) {
    return this.request<ListTopicNotesResp>(
      "GET",
      "/resource/knowledge/notes",
      { topic_id: params.topic_id, page: params.page }
    );
  }

  async batchAddNotesToTopic(body: { topic_id: string; note_ids: (number | string)[] }) {
    return this.request<BatchAddNotesResp>(
      "POST",
      "/resource/knowledge/note/batch-add",
      undefined,
      body
    );
  }

  async removeNoteFromTopic(body: { topic_id: string; note_ids: (number | string)[] }) {
    return this.request<RemoveNoteResp>(
      "POST",
      "/resource/knowledge/note/remove",
      undefined,
      body
    );
  }

  // ─── Knowledge / Bloggers ────────────────────────────────────────────────

  async listTopicBloggers(params: { topic_id: string; page?: number }) {
    return this.request<ListTopicBloggersResp>(
      "GET",
      "/resource/knowledge/bloggers",
      { topic_id: params.topic_id, page: params.page }
    );
  }

  async listTopicBloggerContents(params: {
    topic_id: string;
    follow_id: number | string;
    page?: number;
  }) {
    return this.request<ListTopicBloggerContentsResp>(
      "GET",
      "/resource/knowledge/blogger/contents",
      { topic_id: params.topic_id, follow_id: params.follow_id, page: params.page }
    );
  }

  async getBloggerContentDetail(params: { topic_id: string; post_id: string }) {
    return this.request<BloggerContentDetail>(
      "GET",
      "/resource/knowledge/blogger/content/detail",
      { topic_id: params.topic_id, post_id: params.post_id }
    );
  }

  // ─── Knowledge / Lives ───────────────────────────────────────────────────

  async listTopicLives(params: { topic_id: string; page?: number }) {
    return this.request<ListTopicLivesResp>(
      "GET",
      "/resource/knowledge/lives",
      { topic_id: params.topic_id, page: params.page }
    );
  }

  async getLiveDetail(params: { topic_id: string; live_id: number | string }) {
    return this.request<LiveDetail>(
      "GET",
      "/resource/knowledge/live/detail",
      { topic_id: params.topic_id, live_id: params.live_id }
    );
  }

  // ─── Rate Limit / Quota ──────────────────────────────────────────────────

  async getQuota() {
    return this.request<GetQuotaResp>("GET", "/resource/rate-limit/quota");
  }

  // ─── Recall / Search ─────────────────────────────────────────────────────

  async recall(body: { query: string; top_k?: number }) {
    return this.request<RecallResp>("POST", "/resource/recall", undefined, body);
  }

  async recallKnowledge(body: { topic_id: string; query: string; top_k?: number }) {
    return this.request<RecallResp>("POST", "/resource/recall/knowledge", undefined, body);
  }
}

// ─── Response Types ──────────────────────────────────────────────────────────

export interface TagInfo {
  id: string;
  name: string;
  type: "ai" | "manual" | "system";
}

export interface NoteItem {
  id: number;
  title: string;
  content: string;
  ref_content?: string;
  note_type: string;
  source: string;
  tags: TagInfo[];
  parent_id?: number;
  children_count?: number;
  topics?: { id: string; name: string }[];
  is_child_note?: boolean;
  created_at: string;
  updated_at: string;
}

export interface NoteDetail extends NoteItem {
  entry_type?: string;
  attachments?: {
    type: string;
    url: string;
    title?: string;
    size?: number;
    duration?: number;
  }[];
  audio?: {
    play_url?: string;
    duration?: number;
    /** 录音转写原文（未经 AI 润色的原始转写文本） */
    original?: string;
  };
  web_page?: {
    url: string;
    domain?: string;
    excerpt?: string;
    /** 链接原文（网页正文内容） */
    content?: string;
  };
  share_id?: string;
  version?: number;
}

export interface ListNotesResp {
  notes: NoteItem[];
  has_more: boolean;
  next_cursor?: number;
  total: number;
}

export interface GetNoteResp {
  note: NoteDetail;
}

export interface SaveNoteReq {
  id?: number | string;
  title?: string;
  content?: string;
  note_type?: "plain_text" | "link" | "img_text";
  tags?: string[];
  parent_id?: number | string;
  link_url?: string;
  image_urls?: string[];
}

export interface NoteTaskItem {
  /** 任务 ID */
  task_id: string;
  /** 链接 URL */
  url: string;
}

export interface SaveNoteResp {
  id: number;
  title: string;
  created_at: string;
  updated_at: string;
  message?: string;
  /** 链接笔记创建时返回的任务列表 */
  tasks?: NoteTaskItem[];
  /** 成功创建的笔记数量 */
  created_count?: number;
  /** 重复的链接数量（已存在） */
  duplicate_count?: number;
  /** 无效的链接数量 */
  invalid_count?: number;
}

export interface NoteTaskProgress {
  /** 任务 ID */
  task_id: string;
  /** 任务类型，目前为 "link" */
  task_type: string;
  /** 任务状态：pending / processing / success / failed */
  status: "pending" | "processing" | "success" | "failed";
  /** 笔记 ID（status 为 success 时返回） */
  note_id?: number;
  /** 错误信息（status 为 failed 时返回） */
  error_msg?: string;
  /** 任务创建时间 */
  create_time: string;
  /** 任务最后更新时间 */
  update_time: string;
}

export interface DeleteNoteResp {
  note_id: number;
}

export interface AddNoteTagsResp {
  note_id: number;
  tags: TagInfo[];
}

export interface DeleteNoteTagResp {
  note_id: number;
  tags: TagInfo[];
}

export interface GetUploadConfigResp {
  support_extensions: string[];
  max_size_bytes: number;
  max_count: number;
}

// OSS 上传凭证（与 Web 端格式一致）
export interface ImageUploadToken {
  accessid: string;
  host: string;
  policy: string;
  signature: string;
  expire: number;
  callback: string;
  object_key: string;
  access_url: string;
  oss_content_type: string;
}

// 直接返回单个 token
export type GetUploadTokenResp = ImageUploadToken;

export interface KnowledgeTopic {
  id: string;
  name: string;
  description?: string;
  cover?: string;
  scope?: string;
  created_at?: number;
  updated_at?: number;
}

export interface ListTopicsResp {
  topics: KnowledgeTopic[];
  has_more: boolean;
  total: number;
}

export interface CreateTopicResp {
  id: string;
  name: string;
  description?: string;
  cover?: string;
  scope?: string;
}

export interface TopicNoteItem {
  note_id: number;
  title: string;
  content: string;
  note_type: string;
  tags: string[];
  is_ai?: boolean;
  created_at: string;
  edit_time: string;
}

export interface ListTopicNotesResp {
  notes: TopicNoteItem[];
  has_more: boolean;
  total: number;
}

export interface BatchAddNotesResp {
  topic_id?: string;
  success_count: number;
  failed_note_ids: (number | string)[];
}

export interface RemoveNoteResp {
  removed_count: number;
  failed_note_ids: (number | string)[];
}

export interface QuotaInfo {
  limit: number;
  used: number;
  remaining: number;
  reset_at: number;
}

export interface QuotaBucket {
  daily: QuotaInfo;
  monthly: QuotaInfo;
}

export interface GetQuotaResp {
  read: QuotaBucket;
  write: QuotaBucket;
  write_note: QuotaBucket;
}

// ─── Blogger Types ───────────────────────────────────────────────────────────

export interface BloggerItem {
  follow_id: number;
  account_name: string;
  account_avatar: string;
  notes_count: number;
  platform: string;
  hook_state: string;
  follow_time: string;
  follow_link: string;
}

export interface ListTopicBloggersResp {
  bloggers: BloggerItem[];
  has_more: boolean;
  total: number;
}

export interface BloggerContentItem {
  post_id_alias: string;
  post_name: string;
  post_type: string;
  post_cover: string;
  post_title: string;
  post_summary: string;
  post_url: string;
  post_icon: string;
  post_subtitle: string;
  post_create_time: string;
  post_publish_time: string;
}

export interface ListTopicBloggerContentsResp {
  contents: BloggerContentItem[];
  has_more: boolean;
  total: number;
}

export interface BloggerContentDetail extends BloggerContentItem {
  post_media_text: string;
}

// ─── Live Types ──────────────────────────────────────────────────────────────

export interface LiveItem {
  live_id: number;
  follow_id: number;
  name: string;
  cover: string;
  sub_title: string;
  link: string;
  platform: string;
  status: string;
  follow_time: string;
}

export interface ListTopicLivesResp {
  lives: LiveItem[];
  has_more: boolean;
  total: number;
}

export interface LiveDetail {
  post_id_alias: string;
  post_name: string;
  post_type: string;
  post_cover: string;
  post_subtitle: string;
  post_url: string;
  post_title: string;
  post_summary: string;
  post_media_text: string;
  post_create_time: string;
  post_publish_time: string;
}

// ─── Update Note Types ───────────────────────────────────────────────────────

export interface UpdateNoteReq {
  note_id: number | string;
  title?: string;
  content?: string;
  tags?: string[];
}

export interface UpdateNoteResp {
  note_id: number;
  title: string;
  updated_at: string;
}

// ─── Recall / Search Types ───────────────────────────────────────────────────

export interface RecallResultItem {
  note_id: string;
  note_type: "NOTE" | "FILE" | "BLOGGER" | "LIVE" | "URL" | "DEDAO";
  title: string;
  content: string;
  created_at: string;
  page_no?: number;
}

export interface RecallResp {
  results: RecallResultItem[];
}
