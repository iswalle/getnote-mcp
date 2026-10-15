export interface ReadFailure {httpStatus?:number;code:number;reason:string;retryable:boolean;retryAfterSeconds?:number;waitProvided?:boolean}
const getPaths=new Set([
  "/resource/note/list","/resource/note/detail","/resource/note/marks","/resource/note/sprouts","/resource/note/sprout",
  "/resource/reference/list","/resource/knowledge/list","/resource/knowledge/subscribe/list","/resource/knowledge/notes","/resource/knowledge/directories",
  "/resource/knowledge/file/capabilities","/resource/knowledge/bloggers","/resource/knowledge/blogger/contents","/resource/knowledge/blogger/content/detail",
  "/resource/knowledge/lives","/resource/knowledge/live/detail","/resource/rate-limit/quota"
]);
const postPaths=new Set(["/resource/recall","/resource/recall/knowledge","/resource/note/batch-detail"]);
export function readRetryDelay(method:string,path:string,error:ReadFailure,attempt:number,waited:number):number|undefined {
  if(attempt>=2||waited>=5000||error.httpStatus!==429||!error.retryable)return;
  if(!((error.code===10202&&error.reason==="qps_exceeded")||(error.code===10005&&error.reason==="rate_limited")))return;
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
