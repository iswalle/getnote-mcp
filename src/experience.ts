import {z} from "zod";

export function decimalID(value: string): string {
  if (!/^\d+$/.test(value) || BigInt(value) <= 0n || BigInt(value) > 9223372036854775807n) throw new Error("ID must be a positive signed-64-bit decimal string");
  return BigInt(value).toString();
}
const batchSchema=z.object({ids:z.array(z.string()).min(1).max(200),fields:z.array(z.enum(["content","ref_content","reference","original"])).optional(),max_total_chars:z.number().int().min(1).max(64000).optional()}).strict();
export type BatchDetailOptions=z.infer<typeof batchSchema>;
export function normalizeBatch(input:BatchDetailOptions):BatchDetailOptions {
  const out=batchSchema.parse(input);out.ids=[...new Set(out.ids.map(decimalID))];
  if(out.ids.length>20)throw new Error("batch supports at most20 unique IDs");
  return out;
}
export interface SearchOptions {response_mode?:string;max_snippet_chars?:number}
export function validateSearchOptions(input:SearchOptions):void {
  if(input.response_mode===undefined&&input.max_snippet_chars===undefined)return;
  if(input.response_mode!=="snippet")throw new Error("response_mode must be snippet when requesting snippets");
  if(input.max_snippet_chars!==undefined&&(!Number.isInteger(input.max_snippet_chars)||input.max_snippet_chars<100||input.max_snippet_chars>1000))throw new Error("max_snippet_chars must be 100..1000");
}
export function verifyExperience(body:unknown,path:string,request:unknown):void {
  const input=request as (SearchOptions&{ids?:string[]})|undefined;
  const cap=path==="/resource/note/batch-detail"?"note.batch_detail.v1":input?.response_mode==="snippet"?"search.snippet.v1":undefined;
  if(!cap)return;
  const parsed=z.object({meta:z.object({capabilities:z.array(z.string())}),data:z.record(z.unknown())}).safeParse(body);
  if(!parsed.success||!parsed.data.meta.capabilities.includes(cap))throw new Error(`server does not support ${cap}; new mode was not accepted`);
  const data=parsed.data.data;
  if(cap==="note.batch_detail.v1"){
    const items=z.array(z.object({note_id:z.string(),status:z.string().min(1)})).parse(data.items);
    if(items.length!==input?.ids?.length||items.some((item,i)=>item.note_id!==input.ids?.[i]))throw new Error("batch response lost identities or order");
  }else if(data.response_mode!=="snippet"||data.max_snippet_chars!==(input?.max_snippet_chars??400))throw new Error("server ignored snippet options");
}
