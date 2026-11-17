import {z} from 'zod';
import type {Tool} from '@modelcontextprotocol/sdk/types.js';

const id=z.string().regex(/^\d{1,19}$/).refine(v=>BigInt(v)>0n&&BigInt(v)<=9223372036854775807n,'id must be a positive int64 decimal string').transform(v=>BigInt(v).toString());
export const outlineInput=z.object({id}).strict();
export const sectionInput=outlineInput.extend({offset:z.number().int().min(0).max(3000000).optional(),limit:z.number().int().min(1).max(30000).optional(),keyword:z.string().max(1000).refine(v=>Buffer.from(v,'utf8').toString('utf8')===v,'keyword must be valid Unicode').optional(),version:z.string().refine(v=>Buffer.byteLength(v,'utf8')<=80).optional()}).strict();
export type SectionInput=z.input<typeof sectionInput>;
export interface SectionResponse {id:string;text:string;total:number;version:string;offset_unit:'utf16';meta?:{capabilities?:string[]}}
export function verifyPage(data:SectionResponse,input:{id:string;version?:string}):void{
 if(!data?.meta?.capabilities?.includes('note.progressive_read.v1')||data.id!==input.id||data.offset_unit!=='utf16'||typeof data.version!=='string'||!data.version||typeof data.text!=='string'||!data.text||data.text.length>64000||!Number.isSafeInteger(data.total)||data.total<0||data.total>3000000||(input.version&&data.version!==input.version))throw new Error('Progressive read contract unavailable or invalid; refresh outline or report failure. Do not automatically fetch full content.');
}
const idProperty={type:'string',pattern:'^[0-9]{1,19}$',description:'真实笔记 ID 的十进制字符串；来自列表或搜索结果，不能传 JS Number。'};
export const progressiveTools:Tool[]=[
 {name:'get_note_outline',description:'先看长笔记目录：返回各节的 UTF-16 offset、总长度和 version，不返回整篇正文。用于长会议、录音逐字稿和引用原文定位；再调用 read_note_section。AI 总结、录音转写（原话）、引用原文、个人评论分别标注。',inputSchema:{type:'object',properties:{id:idProperty},required:['id'],additionalProperties:false},annotations:{title:'笔记目录',readOnlyHint:true,destructiveHint:false}},
 {name:'read_note_section',description:'读取一篇笔记的指定节选，或用字面关键词查找原话（不是语义搜索）。使用目录/上一段返回的 UTF-16 offset 和 version；普通读取默认8000、最多30000单元。keyword 用 | 分隔备选词；不传 limit 搜索到文末，传 limit 仅搜索该窗口，无命中不回退前文。内容变化重新取目录，读完停止；失败不自动取全文。',inputSchema:{type:'object',properties:{id:idProperty,offset:{type:'integer',minimum:0,maximum:3000000,description:'原样使用返回的 UTF-16 offset，不能按字节或 Unicode 码点计算'},limit:{type:'integer',minimum:1,maximum:30000,description:'普通读取上限/关键词搜索窗口；不传保留默认语义'},keyword:{type:'string',maxLength:1000,description:'字面关键词，例如 绩效|晋升；不是正则或语义查询'},version:{type:'string',description:'原样使用上次返回的版本；变化则重新获取目录'}},required:['id'],additionalProperties:false},annotations:{title:'读取笔记节选',readOnlyHint:true,destructiveHint:false}}
];
export const canonicalNames:Record<string,string>={recall:'search_account_content',recall_knowledge:'search_knowledge_base',get_notes:'batch_get_notes',list_topics:'list_knowledge_bases',list_topic_notes:'list_knowledge_base_notes',list_topic_directories:'list_knowledge_base_directories',list_topic_bloggers:'list_knowledge_base_bloggers',list_topic_blogger_contents:'list_knowledge_base_blogger_contents',list_topic_lives:'list_knowledge_base_lives',list_subscribe_topics:'list_subscribed_knowledge_bases'};
const legacyNames=Object.fromEntries(Object.entries(canonicalNames).map(([legacy,current])=>[current,legacy]));
export function legacyToolName(name:string):string{return legacyNames[name]??name}
export const serverInstructions='得到大脑（Get笔记）提供个人笔记、录音原话、引用原文和知识库查询。最近笔记用 list_notes；知道书名、课程或设备来源先定位再读取，不把全局语义 Top-K 当完整清单。搜索全账号用 search_account_content，已知知识库用 search_knowledge_base。长文先 get_note_outline，再 read_note_section；保留 UTF-16 offset/version，不能把节选或摘要说成全文。批量结果逐条检查 status、pending_ids 和 partial，未读项按需分段；旧 get_note/original/transcript 保持原行为。写入、删除、分享按用户指令和既有权限执行。';
