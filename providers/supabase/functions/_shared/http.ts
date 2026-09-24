export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, code: string) { super(code); this.status = status; }
}
export function deny(status: number, code: string): never { throw new HttpError(status, code); }
const cors = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'content-type, authorization, apikey','Access-Control-Allow-Methods':'POST, OPTIONS'};
export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value),{status,headers:{...cors,'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
}
export function preflight(req: Request): Response | null {
  if(req.method==='OPTIONS') return new Response(null,{status:204,headers:cors});
  if(req.method!=='POST') return json({error:'METHOD_NOT_ALLOWED'},405);
  if(req.headers.get('content-type')?.split(';')[0].trim()!=='application/json') return json({error:'INVALID_REQUEST'},400);
  return null;
}
export function admission(max: number, concurrency: number, now = Date.now) {
  let start=now(),used=0,active=0;
  return () => {
    if(now()-start>=60000){start=now();used=0;}
    if(++used>max || active>=concurrency) deny(429,'RATE_LIMITED');
    active++; return ()=>{active--;};
  };
}
export async function readJson(req: Request, max: number): Promise<unknown> {
  const length=Number(req.headers.get('content-length')??0);
  if(!Number.isFinite(length)||length<0||length>max||!req.body) deny(413,'BODY_TOO_LARGE');
  const reader=req.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
  const timer=setTimeout(()=>{void reader.cancel();},10000);
  let finished=false;
  try {
    for(;;){const {done,value}=await reader.read();if(done){finished=true;break;}bytes+=value.byteLength;if(bytes>max)deny(413,'BODY_TOO_LARGE');chunks.push(value);}
    const out=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){out.set(chunk,offset);offset+=chunk.byteLength;}
    try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(out));}catch{deny(400,'INVALID_REQUEST');}
  } finally {clearTimeout(timer);if(!finished)await reader.cancel();reader.releaseLock();}
}
export function errorResponse(error: unknown): Response {
  if(error instanceof HttpError)return json({error:error.message},error.status);
  const code=error&&typeof error==='object'&&'code' in error?error.code:null;
  if(code==='23505'||code==='40001')return json({error:'CONFLICT'},409);
  if(code==='42501')return json({error:'PUBLISHER_DENIED'},403);
  if(code==='23514'||code==='22P02')return json({error:'INVALID_STATE'},400);
  if(code==='54000')return json({error:'CAPACITY_LIMIT'},429);
  return json({error:'OTA_UNAVAILABLE'},503);
}
