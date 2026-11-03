import {createHash} from 'node:crypto';
import {waitForReadRetry} from './read-retry';

// Advisory pacing is shared only inside this Node process and authorization
// identity. The server remains authoritative; no credentials are map keys.
interface Queue {
  tail:Promise<void>; pending:number; timer?:NodeJS.Timeout;
  rates:Map<string,number>; last:Map<string,number>; cooldowns:Map<string,number>;
}
const queues=new Map<string,Queue>();
const idleMilliseconds=5*60*1000;
export function authorizationIdentity(baseURL:string,authorization:string,clientID:string):string {
  return createHash('sha256').update(JSON.stringify([baseURL,authorization,clientID])).digest('hex');
}
function abortable<T>(promise:Promise<T>,signal?:AbortSignal):Promise<T>{
  signal?.throwIfAborted();
  if(!signal)return promise;
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(signal.reason??new Error('cancelled'));
    signal.addEventListener('abort',abort,{once:true});
    promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  });
}
export async function inAuthorizationQueue<T>(identity:string,signal:AbortSignal|undefined,work:(queue:Queue)=>Promise<T>):Promise<T>{
  signal?.throwIfAborted();
  let queue=queues.get(identity);
  if(!queue){queue={tail:Promise.resolve(),pending:0,rates:new Map(),last:new Map(),cooldowns:new Map()};queues.set(identity,queue)}
  clearTimeout(queue.timer);queue.pending++;
  const previous=queue.tail;let release!:()=>void;
  queue.tail=new Promise<void>(r=>release=r);
  const slot=queue;
  // A cancelled waiter releases its slot only after its predecessor, so a
  // later request can never overtake a still running operation.
  try {await abortable(previous,signal);signal?.throwIfAborted();return await work(slot)}
  finally {
    previous.then(release);
    if(--slot.pending===0){slot.timer=setTimeout(()=>{if(queues.get(identity)===slot&&slot.pending===0)queues.delete(identity)},idleMilliseconds);slot.timer.unref()}
  }
}
export function learnPolicy(queue:Queue,data:unknown):void {
  const value=data as {rate_limit_policy?:{rates?:unknown};runtime?:{rate_limit_policy?:{rates?:unknown}}}|undefined;
  const rates=value?.rate_limit_policy?.rates??value?.runtime?.rate_limit_policy?.rates;
  if(!rates||typeof rates!=='object'||Array.isArray(rates))return;
  queue.rates.clear();
  for(const [bucket,raw]of Object.entries(rates))learnRate(queue,bucket,(raw as {sustained_rate_per_second?:unknown})?.sustained_rate_per_second);
}
export function learnRate(queue:Queue,bucket:unknown,rate:unknown):void {
  if(typeof bucket==='string'&&['global','read','write','write_note','upload_credential'].includes(bucket)&&typeof rate==='number'&&Number.isFinite(rate)&&rate>0)queue.rates.set(bucket,rate);
}
export function learnCooldown(queue:Queue,bucket:string,milliseconds:number):void {
  if(!Number.isFinite(milliseconds)||milliseconds<0)return;
  queue.cooldowns.set(bucket,Math.max(queue.cooldowns.get(bucket)??0,performance.now()+milliseconds));
}
export async function pace(queue:Queue,bucket:string,signal?:AbortSignal,maxWait=Infinity):Promise<boolean>{
  let delay=0;const now=performance.now();
  for(const key of ['global',bucket]){
    delay=Math.max(delay,(queue.cooldowns.get(key)??0)-now);
    const rate=queue.rates.get(key),last=queue.last.get(key);
    if(rate!==undefined&&last!==undefined)delay=Math.max(delay,last+1000/rate-now);
  }
  if(delay>maxWait)return false;
  const deadline=performance.now()+delay;
  // Node clamps timer values above int32 to one millisecond. Chunk long policy
  // waits so they remain cancellable without dispatching early.
  for(let remaining=deadline-performance.now();remaining>0;remaining=deadline-performance.now())await waitForReadRetry(Math.min(Math.ceil(remaining),2147483647),signal);
  signal?.throwIfAborted();const started=performance.now();queue.last.set('global',started);queue.last.set(bucket,started);return true;
}
