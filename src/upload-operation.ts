import {randomUUID} from 'node:crypto';

export type UploadKind='image'|'file';
export const uploadRoutes={image:'/resource/image',file:'/resource/knowledge/file'};
export interface UploadRuntime {
  governance_enabled?:boolean;operation_replay?:boolean;idempotency_header?:string;operation_status_endpoint?:string;
  [key:string]:unknown;
}
export interface UploadOperation {
  operation_id:string;upload_id?:string;state:string;resume_until:string;credential?:Record<string,unknown>;
  [key:string]:unknown;
}
export function validateOperationID(value:string):string {
  if(typeof value!=='string'||!(/^[A-Za-z0-9._:-]{1,128}$/).test(value))throw new Error('operation_id must match ^[A-Za-z0-9._:-]{1,128}$');
  return value;
}
export function supportsRecovery(runtime:UploadRuntime|undefined,kind:UploadKind):boolean {
  return runtime?.governance_enabled===true&&runtime?.operation_replay===true&&runtime.idempotency_header==='Idempotency-Key'&&runtime.operation_status_endpoint==='/open/api/v1'+uploadRoutes[kind]+'/upload_operation';
}
export function newOperationID():string {return randomUUID()}
