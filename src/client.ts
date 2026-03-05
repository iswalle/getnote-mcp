import axios, { AxiosInstance, AxiosError } from "axios";

const BASE_URL = "https://open.getnotes.cn/api/v1";

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

  constructor(apiKey: string) {
    this.http = axios.create({
      baseURL: BASE_URL,
      headers: {
        Authorization: `Bearer ${apiKey}`,
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

  async listNotes(params: { limit?: number; since_id: number | string }) {
    return this.request<ListNotesResp>("GET", "/resource/note/list", {
      limit: params.limit,
      since_id: params.since_id,
    });
  }

  async getNote(id: number | string) {
    return this.request<GetNoteResp>("GET", "/resource/note/detail", { id });
  }

  async saveNote(body: SaveNoteReq) {
    return this.request<SaveNoteResp>("POST", "/resource/note/save", undefined, body);
  }

  async deleteNote(note_id: number | string) {
    return this.request<DeleteNoteResp>("POST", "/resource/note/delete", undefined, {
      note_id,
    });
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

  // ─── Rate Limit / Quota ──────────────────────────────────────────────────

  async getQuota() {
    return this.request<GetQuotaResp>("GET", "/resource/rate-limit/quota");
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
    transcript?: string;
  };
  web_page?: {
    url: string;
    domain?: string;
    excerpt?: string;
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
  note_type?: "plain_text" | "link";
  tags?: string[];
  parent_id?: number | string;
  link_url?: string;
  image_urls?: string[];
}

export interface SaveNoteResp {
  id: number;
  title: string;
  created_at: string;
  updated_at: string;
  message?: string;
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

export interface ImageUploadToken {
  sign_url: string;
  get_url: string;
  object_key: string;
  mime_type: string;
}

export interface GetUploadTokenResp {
  tokens: ImageUploadToken[];
}

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
