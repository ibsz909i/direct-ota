import {exactKeys,object,validateSelector,verifyManifest,verifyPublishCommand,type OtaTrust,type OtaArtifact} from './protocol.ts';
import {admission,deny,errorResponse,json,preflight,readJson} from './http.ts';
type Row={platform:string;channel:string;runtime:string;manifest:string};
const key=(s:{platform:string;channel:string;runtime:string})=>`${s.platform}:${s.channel}:${s.runtime}`;
export function createCheckHandler(deps:{trust:OtaTrust;catalog:()=>Promise<Row[]>;now?:()=>number;requestsPerMinute?:number}) {
  const now=deps.now??Date.now,enter=admission(deps.requestsPerMinute??1200,64,now);
  let catalog=new Map<string,string>(),expires=0,cooldown=0,pending:Promise<void>|null=null;
  const verified=new Set<string>();
  async function refresh(){
    if(expires>now())return;
    if(cooldown>now())deny(503,'OTA_UNAVAILABLE');
    if(!pending)pending=(async()=>{
      try{
        const rows=await deps.catalog();if(!Array.isArray(rows)||rows.length>256)throw Error('Invalid catalog');
        const next=new Map<string,string>();
        for(const row of rows){validateSelector({platform:row.platform,channel:row.channel,runtime:row.runtime});if(typeof row.manifest!=='string'||row.manifest.length>8192||next.has(key(row)))throw Error('Invalid catalog');next.set(key(row),row.manifest);}
        catalog=next;verified.clear();expires=now()+15000;
      }catch(error){cooldown=now()+5000;throw error;}finally{pending=null;}
    })();
    await pending;
  }
  return async(req:Request)=>{
    let leave:(()=>void)|undefined;
    try{
      leave=enter();const early=preflight(req);if(early)return early;
      let selected;try{selected=validateSelector(await readJson(req,512));}catch(error){if(error instanceof Error&&'status' in error)throw error;deny(400,'INVALID_REQUEST');}
      await refresh();const manifest=catalog.get(key(selected))??null;
      if(manifest&&!verified.has(manifest)){await verifyManifest(manifest,deps.trust,selected);verified.add(manifest);}
      return json({manifest});
    }catch(error){return errorResponse(error);}finally{leave?.();}
  };
}
export function createPublishHandler(deps:{trust:OtaTrust;command:(args:Record<string,unknown>)=>Promise<Record<string,unknown>>;inspect:(artifact:OtaArtifact)=>Promise<boolean>;upload:(path:string)=>Promise<{url:string;method:'PUT';headers?:Record<string,string>}>;requestsPerMinute?:number}) {
  const enter=admission(deps.requestsPerMinute??60,8);
  return async(req:Request)=>{
    let leave:(()=>void)|undefined;
    try{
      leave=enter();const early=preflight(req);if(early)return early;
      const input=await readJson(req,24576);let cmd;
      try{exactKeys(object(input),['command']);cmd=await verifyPublishCommand((input as {command:string}).command,deps.trust);}catch{deny(401,'INVALID_SIGNATURE');}
      let manifest=null;
      try{
        if(cmd.action==='status')validateSelector(cmd.body);
        else{exactKeys(cmd.body,cmd.action==='reserve'?['manifest']:['manifest','expectedSequence']);manifest=await verifyManifest(cmd.body.manifest as string,deps.trust);if(cmd.action==='promote'&&(!Number.isSafeInteger(cmd.body.expectedSequence)||(cmd.body.expectedSequence as number)<0||manifest.sequence!==(cmd.body.expectedSequence as number)+1))deny(400,'INVALID_SEQUENCE');}
      }catch{deny(400,'INVALID_MANIFEST');}
      if(cmd.action==='reserve'&&manifest?.action!=='release')deny(400,'NO_ARTIFACT');
      if(cmd.action==='promote'&&manifest?.action==='release'&&!await deps.inspect(manifest.artifact))deny(400,'INCOMPLETE_ARTIFACT');
      const verified=cmd.action==='promote'&&manifest?.action==='release'?manifest.artifact:null;
      const result=await deps.command({p_key_id:deps.trust.keyId,p_nonce:cmd.nonce,p_expires_at:new Date(cmd.exp*1000).toISOString(),p_action:cmd.action,p_manifest:manifest?cmd.body.manifest:null,p_payload:manifest,p_selector:cmd.action==='status'?cmd.body:null,p_expected_sequence:cmd.action==='promote'?cmd.body.expectedSequence:null,p_verified_sha256:verified?.sha256??null,p_verified_bytes:verified?.bytes??null});
      if(cmd.action==='reserve'&&result.uploadRequired===true){
        if(manifest?.action!=='release'||result.path!==manifest.artifact.path)throw Error('Invalid reservation');
        return json({releaseId:manifest.releaseId,uploadRequired:true,upload:await deps.upload(manifest.artifact.path)});
      }
      return json(result);
    }catch(error){return errorResponse(error);}finally{leave?.();}
  };
}
