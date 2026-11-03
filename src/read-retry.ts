export interface ReadFailure {httpStatus?:number;code:number;reason:string;retryable:boolean;retryAfterSeconds?:number;waitProvided?:boolean;rateLimitDetail?:unknown}
const getPaths=new Set([
  "/resource/note/list","/resource/note/detail","/resource/note/marks","/resource/note/sprouts","/resource/note/sprout",
  "/resource/reference/list","/resource/knowledge/list","/resource/knowledge/subscribe/list","/resource/knowledge/notes","/resource/knowledge/directories",
  "/resource/image/config","/resource/image/upload_operation","/resource/knowledge/file/upload_operation","/resource/knowledge/file/capabilities","/resource/knowledge/bloggers","/resource/knowledge/blogger/contents","/resource/knowledge/blogger/content/detail",
  "/resource/knowledge/lives","/resource/knowledge/live/detail","/resource/rate-limit/quota"
]);
const postPaths=new Set(["/resource/recall","/resource/recall/knowledge","/resource/note/batch-detail"]);
const writePaths=new Set([
  '/resource/note/save','/resource/note/delete','/resource/note/update','/resource/note/task/progress',
  '/resource/note/tags/add','/resource/note/tags/delete','/resource/note/sharing',
  '/resource/knowledge/create','/resource/knowledge/note/batch-add','/resource/knowledge/note/remove',
  '/resource/knowledge/directory/create','/resource/knowledge/directory/update','/resource/knowledge/directory/delete',
  '/resource/knowledge/blogger/follow','/resource/knowledge/live/follow','/resource/knowledge/file/upload'
]);
export function operationBucket(method:string,path:string):string {
  if(path.endsWith('/upload_token'))return 'upload_credential';
  if(path==='/resource/note/save')return 'write_note';
  return method==='GET'||postPaths.has(path)?'read':'write';
}
export function readRetryDelay(method:string,path:string,error:ReadFailure,attempt:number,waited:number,idempotencyKey?:string):number|undefined {
  if(attempt>=2||waited>=5000||error.httpStatus!==429||error.retryable!==true)return;
  if(error.rateLimitDetail!==undefined){
    const d=error.rateLimitDetail as Record<string,unknown>|null;
    if(!d||typeof d!=='object'||Array.isArray(d)||d.dimension!=='qps'||d.request_execution!=='not_started'||d.retry_action!=='retry_same_operation'||d.retryable!==true)return;
    const knownRead=method==='GET'&&getPaths.has(path)||method==='POST'&&postPaths.has(path);
    const knownWrite=method==='POST'&&writePaths.has(path);
    const credential=method==='GET'&&['/resource/image/upload_token','/resource/knowledge/file/upload_token'].includes(path)&&!!idempotencyKey;
    if(!knownRead&&!knownWrite&&!credential)return;
    const waits:number[]=[];
    for(const [key,scale]of [['retry_after_ms',1],['retry_after_seconds',1000]] as const){
      if(d[key]!==undefined){if(typeof d[key]!=='number'||!Number.isSafeInteger(d[key])||(d[key] as number)<0)return;waits.push((d[key] as number)*scale)}
    }
    if(error.waitProvided&&error.retryAfterSeconds===undefined)return;
    if(error.retryAfterSeconds!==undefined)waits.push(error.retryAfterSeconds*1000);
    const delay=(waits.length?Math.max(...waits):200*2**attempt)+1+Math.floor(Math.random()*50);
    return delay<=5000-waited?delay:undefined;
  }
  const qpsLimit=error.code===10202&&["qps_exceeded","qps_global_exceeded","qps_bucket_exceeded"].includes(error.reason);
  if(!qpsLimit&&!(error.code===10005&&error.reason==="rate_limited"))return;
  if(!(method==="GET"?getPaths.has(path):method==="POST"&&postPaths.has(path)))return;
  if(error.waitProvided&&error.retryAfterSeconds===undefined)return;
  const wait=error.retryAfterSeconds;
  if(wait!==undefined&&(!Number.isSafeInteger(wait)||wait<0||wait>(5000-waited)/1000))return;
  const delay=(wait===undefined?200*2**attempt:wait*1000)+1+Math.floor(Math.random()*50);
  return delay<=5000-waited?delay:undefined;
}
export async function waitForReadRetry(delay:number,signal?:AbortSignal):Promise<void>{
  signal?.throwIfAborted();
  await new Promise<void>((resolve,reject)=>{
    const abort=()=>{clearTimeout(timer);signal?.removeEventListener("abort",abort);reject(signal?.reason??new Error("cancelled"))};
    const timer=setTimeout(()=>{signal?.removeEventListener("abort",abort);resolve()},delay);
    signal?.addEventListener("abort",abort,{once:true});
  });
}
