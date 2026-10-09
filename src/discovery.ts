import { z } from "zod";

const text = z.string().trim().min(1);
const integer = z.number().int().positive();
const view = z.enum(["summary", "full"]);
const times = ["created_from", "created_to", "edited_from", "edited_to", "record_updated_from", "record_updated_to"] as const;
export const noteSelectors = {
  view: view.optional(), source: text.optional(), note_type: text.optional(),
  reference_resource_type: text.optional(), reference_resource_id: text.optional(),
  reference_article_url: z.string().url().refine(v => /^https?:\/\//.test(v)).optional(),
  topic_id: text.optional(), page_size: integer.max(100).optional(),
  created_from: text.optional(), created_to: text.optional(), edited_from: text.optional(), edited_to: text.optional(),
  record_updated_from: text.optional(), record_updated_to: text.optional(),
};
export type NoteDiscoveryOptions = z.infer<ReturnType<typeof noteSchema>>;
function noteSchema() { return z.object({ ...noteSelectors, page: integer.optional(), cursor: z.string().min(1).optional() }).strict(); }
const lookupSchema = z.object({ page: integer.optional(), scope: z.enum(["DEFAULT", "CUSTOMER", "BOOKSPACE", "TEAMSPACE"]).optional(), query: text.optional(), author: text.optional(), book_id: text.optional(), page_size: integer.max(100).optional() }).strict();
export type LookupOptions = z.infer<typeof lookupSchema>;
export type DiscoveryKind = "notes" | "topicNotes" | "topics" | "detail";
export type DiscoveryContract = { params: Record<string, unknown>; filters: Record<string, string>; capabilities: string[]; kind: DiscoveryKind };

export function normalizeLookup(value: string): string {
  value = value.normalize("NFKC").trim();
  for (const [left, right] of [["《", "》"], ["“", "”"], ['"', '"'], ["'", "'"]]) {
    if (value.startsWith(left) && value.endsWith(right) && value.length >= left.length + right.length) { value = value.slice(left.length, -right.length).trim(); break; }
  }
  return value.toLowerCase();
}

// Keep nanoseconds: Date alone would round distinct reference/time boundaries.
function timestamp(value: string): { text: string; epoch: bigint } {
  z.string().datetime({ offset: true }).parse(value);
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!m) throw new Error("time filters require RFC3339 with timezone");
  const ms = Date.parse(m[1] + m[3]);
  if (!Number.isFinite(ms)) throw new Error("invalid time filter");
  const fraction = (m[2] || "").replace(/0+$/, "");
  return { text: new Date(ms).toISOString().slice(0, 19) + (fraction ? "." + fraction : "") + "Z", epoch: BigInt(ms) * 1000000n + BigInt((m[2] || "").padEnd(9, "0")) };
}

export function discoveryContract(kind: DiscoveryKind, input: Record<string, unknown>): DiscoveryContract | undefined {
  const values = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
  const legacy = kind === "topics" ? ["page", "scope"] : kind === "detail" ? ["id", "image_quality"] : kind === "topicNotes" ? ["topic_id", "page"] : ["cursor"];
  if (!Object.keys(values).some(k => !legacy.includes(k))) return undefined;
  let params: Record<string, unknown>;
  const filters: Record<string, string> = {};
  if (kind === "detail") {
    params = z.object({ id: z.union([text, z.number().int().safe()]), image_quality: z.enum(["original"]).optional(), view }).strict().parse(values);
    return { params, filters, capabilities: ["note.reference.v1", ...(params.view === "summary" ? ["note.summary.v1"] : [])], kind };
  }
  if (kind === "topics") {
    params = { scope: "DEFAULT", page: 1, page_size: 20, ...lookupSchema.parse(values) };
    if (params.scope !== "BOOKSPACE" && (params.author || params.book_id)) throw new Error("author and book_id require BOOKSPACE");
    for (const key of ["query", "author"]) if (typeof params[key] === "string") params[key] = normalizeLookup(params[key] as string);
  } else {
    params = { page_size: 20, ...(kind === "topicNotes" ? { page: 1 } : {}), ...noteSchema().parse(values) };
    if (kind === "topicNotes" && !params.topic_id) throw new Error("topic_id is required");
    if (params.page && (!params.topic_id || params.cursor)) throw new Error("page requires topic_id and cannot be combined with cursor");
    if (params.reference_resource_id) {
      if (!params.source || !params.reference_resource_type) throw new Error("reference ID requires source and resource type");
      const id = String(params.reference_resource_id);
      if (!/^\d+$/.test(id) || BigInt(id) <= 0n || BigInt(id) > 9223372036854775807n) throw new Error("invalid reference ID");
    }
    const epochs: Record<string, bigint> = {};
    for (const key of times) if (typeof params[key] === "string") { const t = timestamp(params[key] as string); params[key] = t.text; epochs[key] = t.epoch; }
    for (const prefix of ["created", "edited", "record_updated"]) if (epochs[prefix + "_from"] !== undefined && epochs[prefix + "_to"] !== undefined && epochs[prefix + "_from"] >= epochs[prefix + "_to"]) throw new Error("time interval must have from < to");
  }
  for (const [key, value] of Object.entries(params)) if (!["view", "cursor", "page", "page_size"].includes(key)) filters[key] = String(value);
  const capabilities = ["pagination.v1"];
  if (kind === "topics") capabilities.push("knowledge.lookup.v1");
  else if (Object.keys(filters).length) capabilities.push("note.filters.v1");
  if (Object.keys(filters).some(k => k.startsWith("reference_")) || params.view === "summary") capabilities.push("note.reference.v1");
  if (params.view === "summary") capabilities.push("note.summary.v1");
  return { params, filters, capabilities, kind };
}

export function verifyDiscovery(body: unknown, contract: DiscoveryContract): void {
  const envelope = z.object({ meta: z.object({ capabilities: z.array(z.string()) }), data: z.record(z.unknown()) }).safeParse(body);
  if (!envelope.success) throw new Error("server does not declare discovery capabilities; upgrade the server (unfiltered results not accepted)");
  for (const cap of contract.capabilities) if (!envelope.data.meta.capabilities.includes(cap)) throw new Error(`server does not support ${cap}; unfiltered results not accepted`);
  if (contract.kind === "detail") return;
  const data = envelope.data.data;
  const applied = z.record(z.string()).safeParse(data.applied_filters);
  if (!applied.success) throw new Error("server did not return applied_filters");
  for (const [key, value] of Object.entries(contract.filters)) if (applied.data[key] !== value) throw new Error(`server did not apply ${key}`);
  const p = z.object({ mode: z.enum(["page", "cursor"]), page: integer.nullable(), page_size: integer.max(100), returned_count: z.number().int().nonnegative(), total_count: z.number().int().nonnegative().nullable(), has_more: z.boolean(), next_page: integer.nullable(), next_cursor: z.string().min(1).nullable() }).parse(data.pagination);
  const items = data[contract.kind === "topics" ? "topics" : "notes"];
  const page = contract.params.page;
  if (!Array.isArray(items) || p.mode !== (page ? "page" : "cursor") || p.page_size !== contract.params.page_size || p.returned_count !== items.length || items.length > p.page_size || (p.total_count !== null && p.total_count < items.length) || (page && p.page !== page)) throw new Error("invalid discovery pagination response");
  if (p.has_more ? (page ? p.next_page !== Number(page) + 1 || p.next_cursor !== null : !p.next_cursor || p.next_page !== null) : p.next_page !== null || p.next_cursor !== null) throw new Error("invalid discovery continuation");
}
