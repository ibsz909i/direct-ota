import {validateTrust,type OtaTrust,type OtaArtifact} from './protocol.ts';
export function service() {
  const trust=validateTrust(JSON.parse(Deno.env.get('OTA_TRUST_JSON')??'null')) as OtaTrust;
  const base=Deno.env.get('SUPABASE_URL')??'',secret=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const url=new URL(base);
  if(url.protocol!=='https:'||url.origin!==base||!secret||trust.artifactBaseUrl!==base+'/storage/v1/object/public/direct-ota')throw Error('Invalid OTA service configuration');
  async function call(path:string,payload:unknown,limit=32768):Promise<unknown>{
    const res=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+secret,'apikey':secret!},body:JSON.stringify(payload),redirect:'error',signal:AbortSignal.timeout(8000)});
    if(!res.body)throw Error('Empty service response');
    const reader=res.body.getReader(),chunks:Uint8Array[]=[];let size=0;
    try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit)throw Error('Oversized response');chunks.push(value);}}finally{await reader.cancel();}
    const data=new Uint8Array(size);let at=0;for(const chunk of chunks){data.set(chunk,at);at+=chunk.byteLength;}
    const parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));
    if(!res.ok)throw {code:typeof parsed.code==='string'?parsed.code:'SERVICE_ERROR'};
    return parsed;
  }
  return {
    trust,
    async catalog(){const rows=await call('/rest/v1/rpc/direct_ota_catalog',{},2200000);if(!Array.isArray(rows))throw Error('Invalid catalog');return rows;},
    async command(args:Record<string,unknown>){const value=await call('/rest/v1/rpc/direct_ota_command',args);if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid command result');return value as Record<string,unknown>;},
    async upload(path:string):Promise<{url:string;method:'PUT';headers:Record<string,string>}>{
      // path comes only from a verified manifest and matching database reservation.
      // Storage's default is create-only; enabling upsert requires a separate
      // x-upsert:true request header, which this service never sends.
      const result=await call('/storage/v1/object/upload/sign/direct-ota/'+path,{}) as {url?:string;token?:string};
      let signed:string;
      if(result.url?.startsWith('/object/upload/sign/'))signed=base+'/storage/v1'+result.url;
      else if(result.token)signed=base+'/storage/v1/object/upload/sign/direct-ota/'+path+'?token='+encodeURIComponent(result.token);
      else throw Error('Upload capability unavailable');
      const target=new URL(signed);
      if(target.origin!==base||target.pathname!=='/storage/v1/object/upload/sign/direct-ota/'+path||!target.searchParams.get('token')||[...target.searchParams.keys()].some(k=>k!=='token'))throw Error('Invalid upload destination');
      return {url:target.href,method:'PUT',headers:{'Content-Type':'application/zip','x-upsert':'false'}};
    },
    async inspect(artifact:OtaArtifact){
      const res=await fetch(artifact.url,{redirect:'error',cache:'no-store',headers:{'Accept-Encoding':'identity'},signal:AbortSignal.timeout(15000)});
      if(!res.ok||!res.body){await res.body?.cancel();return false;}
      const declared=res.headers.get('content-length');if(declared!==null&&Number(declared)!==artifact.bytes){await res.body.cancel();return false;}
      const bytes=new Uint8Array(artifact.bytes),reader=res.body.getReader();let size=0;
      try{for(;;){const {done,value}=await reader.read();if(done)break;if(size+value.byteLength>artifact.bytes)return false;bytes.set(value,size);size+=value.byteLength;}}finally{await reader.cancel();}
      if(size!==artifact.bytes)return false;
      const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
      return hash===artifact.sha256;
    },
  };
}
