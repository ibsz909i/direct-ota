import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,createHash,randomUUID} from 'node:crypto';
import {mkdtemp,rm,stat,readdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {createOtaServer} from '../providers/node/server.mjs';
import {signJws} from '../cli/crypto.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t,options={}){
 const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),trust={appId:'app.example.demo',environment:'production',backendContract:1,keyId:'synthetic',publicJwk:keys.publicKey.export({format:'jwk'}),artifactBaseUrl:'https://updates.example.invalid/artifacts'};
 const dataDir=await mkdtemp(join(tmpdir(),'direct-ota-server-'));
 const server=await createOtaServer({trust,dataDir,...options});server.listen(0,'127.0.0.1');await once(server,'listening');
 const origin='http://127.0.0.1:'+server.address().port;
 t.after(async()=>{server.closeAllConnections();if(server.listening){server.close();await once(server,'close');}await rm(dataDir,{recursive:true,force:true});});
 const post=(path,value)=>fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
 const signedCommand=(action,body,nonce=randomUUID())=>{const iat=Math.floor(Date.now()/1000);return signJws({protocol:1,appId:trust.appId,aud:'direct-ota-publish',action,iat,exp:iat+60,nonce,body},keys.privateKey,trust.keyId,'DIRECT-OTA-PUBLISH');};
 const command=(action,body,nonce)=>post('/publish',{command:signedCommand(action,body,nonce)});
 const selector={platform:'ios',channel:'internal',runtime:'a'.repeat(64)};
 function release(sequence=1,{bytes=Buffer.from('synthetic ciphertext'),...overrides}={}){
  const releaseId=randomUUID(),sha256=hash(bytes),path=`ios/${selector.runtime}/${releaseId}/${sha256}.zip`;
  const manifest={protocol:1,appId:trust.appId,environment:trust.environment,backendContract:1,...selector,sequence,action:'release',rollout:100,releaseId,version:'1.0.1',issuedAt:new Date().toISOString(),artifact:{path,url:trust.artifactBaseUrl+'/'+path,sha256,bytes:bytes.length,unpackedBytes:100,files:1,checksum:Buffer.alloc(256).toString('base64'),sessionKey:Buffer.alloc(16).toString('base64')+':'+Buffer.alloc(256).toString('base64')},...overrides};
  return {manifest,signed:signJws(manifest,keys.privateKey,trust.keyId),bytes};
 }
 async function upload(candidate){const reservation=await command('reserve',{manifest:candidate.signed});assert.equal(reservation.status,200);const response=await reservation.json();if(!response.uploadRequired)return response;const u=new URL(response.upload.url);const result=await fetch(origin+u.pathname+u.search,{method:'PUT',body:candidate.bytes});assert.equal(result.status,201);return response;}
 return {trust,keys,server,dataDir,origin,post,command,signedCommand,selector,release,upload};
}
test('signed publication, public check, immutable upload, ranges and direct withdrawal',async t=>{
 const f=await fixture(t),r=f.release();
 assert.deepEqual(await(await f.post('/check',f.selector)).json(),{manifest:null});
 assert.equal((await f.command('promote',{manifest:r.signed,expectedSequence:0})).status,400);
 const reservation=await f.upload(r),uploadUrl=new URL(reservation.upload.url);
 assert.equal((await fetch(f.origin+uploadUrl.pathname+uploadUrl.search,{method:'PUT',body:r.bytes})).status,409);
 assert.equal((await fetch(f.origin+'/artifacts/'+r.manifest.artifact.path)).status,404);
 assert.equal((await f.command('promote',{manifest:r.signed,expectedSequence:0})).status,200);
 assert.equal((await f.command('promote',{manifest:r.signed,expectedSequence:0})).status,200);
 assert.equal((await(await f.post('/check',f.selector)).json()).manifest,r.signed);
 const delivered=await fetch(f.origin+'/artifacts/'+r.manifest.artifact.path);assert.deepEqual(Buffer.from(await delivered.arrayBuffer()),r.bytes);
 const range=await fetch(f.origin+'/artifacts/'+r.manifest.artifact.path,{headers:{Range:'bytes=5-'}});assert.equal(range.status,206);assert.equal(range.headers.get('content-range'),`bytes 5-${r.bytes.length-1}/${r.bytes.length}`);assert.deepEqual(Buffer.from(await range.arrayBuffer()),r.bytes.subarray(5));
 assert.equal((await fetch(f.origin+'/artifacts/'+r.manifest.artifact.path,{headers:{Range:'bytes=999-'}})).status,416);
 const head=await fetch(f.origin+'/artifacts/'+r.manifest.artifact.path,{method:'HEAD'});assert.equal(head.headers.get('content-length'),String(r.bytes.length));assert.equal(await head.text(),'');
 const withdrawn=f.release(2,{action:'withdraw',artifact:undefined});delete withdrawn.manifest.artifact;withdrawn.signed=signJws(withdrawn.manifest,f.keys.privateKey,f.trust.keyId);
 assert.equal((await f.command('promote',{manifest:withdrawn.signed,expectedSequence:1})).status,200);
 assert.equal((await(await f.post('/check',f.selector)).json()).manifest,withdrawn.signed);
 assert.equal((await stat(join(f.dataDir,'upload-secret'))).mode&0o777,0o600);
});
test('unsigned writes, command replay, malformed selectors and upload capabilities are denied',async t=>{
 const f=await fixture(t);
 assert.equal((await f.post('/publish',{command:'unsigned'})).status,401);
 assert.equal((await fetch(f.origin+'/upload?token=invalid',{method:'PUT',body:'invalid'})).status,403);
 const signed=f.signedCommand('status',f.selector);assert.equal((await f.post('/publish',{command:signed})).status,200);assert.equal((await f.post('/publish',{command:signed})).status,409);
 assert.equal((await f.post('/check',{...f.selector,extra:true})).status,400);
 assert.equal((await f.post('/check',{runtime:'x'.repeat(1024)})).status,413);
 assert.equal((await fetch(f.origin+'/artifacts/%2e%2e/secret')).status,404);
});
test('incomplete and incorrect bytes never publish; a failed upload can be retried',async t=>{
 const f=await fixture(t),r=f.release();const reserve=await(await f.command('reserve',{manifest:r.signed})).json();const url=new URL(reserve.upload.url),target=f.origin+url.pathname+url.search;
 assert.equal((await fetch(target,{method:'PUT',body:r.bytes.subarray(0,3)})).status,400);
 assert.equal((await fetch(target,{method:'PUT',body:Buffer.alloc(r.bytes.length)})).status,400);
 assert.deepEqual(await readdir(join(f.dataDir,'artifacts')),[]);
 assert.deepEqual(await readdir(join(f.dataDir,'staging')),[]);
 assert.equal((await f.command('promote',{manifest:r.signed,expectedSequence:0})).status,400);
 assert.equal((await fetch(target,{method:'PUT',body:r.bytes})).status,201);
 assert.equal((await f.command('promote',{manifest:r.signed,expectedSequence:0})).status,200);
});
test('concurrent channel promotions have one winner and rollback reuses only promoted bytes',async t=>{
 const f=await fixture(t),a=f.release(),b=f.release();await f.upload(a);await f.upload(b);
 const promoted=await Promise.all([a,b].map(r=>f.command('promote',{manifest:r.signed,expectedSequence:0})));assert.deepEqual(promoted.map(r=>r.status).sort(),[200,409]);
 const winner=promoted[0].status===200?a:b,loser=winner===a?b:a;
 const invalid=f.release(2,{artifact:loser.manifest.artifact});assert.equal((await f.command('reserve',{manifest:invalid.signed})).status,400);
 const rollback=f.release(2,{artifact:winner.manifest.artifact});assert.equal((await(await f.command('reserve',{manifest:rollback.signed})).json()).uploadRequired,false);
 assert.equal((await f.command('promote',{manifest:rollback.signed,expectedSequence:1})).status,200);
 const production=f.release(1,{channel:'production',artifact:winner.manifest.artifact});assert.equal((await(await f.command('reserve',{manifest:production.signed})).json()).uploadRequired,false);
 assert.equal((await f.command('promote',{manifest:production.signed,expectedSequence:0})).status,200);
});
test('admission and publisher disablement apply before publication work',async t=>{
 const f=await fixture(t,{limits:{requestsPerMinute:1}});assert.equal((await f.post('/check',f.selector)).status,200);assert.equal((await f.post('/publish',{command:'unsigned'})).status,429);
 const disabled=await fixture(t,{publisherEnabled:false});assert.equal((await disabled.command('status',disabled.selector)).status,403);
});
test('reservations coalesce, storage stays bounded, and state survives a restart',async t=>{
 const f=await fixture(t),r=f.release();
 const results=await Promise.all(Array.from({length:4},()=>f.command('reserve',{manifest:r.signed})));
 assert(results.every(result=>result.status===200));
 await f.upload(r);await f.command('promote',{manifest:r.signed,expectedSequence:0});
 const secret=await readFile(join(f.dataDir,'upload-secret'));
 f.server.closeAllConnections();f.server.close();await once(f.server,'close');
 const restarted=await createOtaServer({trust:f.trust,dataDir:f.dataDir});
 restarted.listen(0,'127.0.0.1');await once(restarted,'listening');
 try{
  const response=await fetch('http://127.0.0.1:'+restarted.address().port+'/check',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(f.selector)});
  assert.equal((await response.json()).manifest,r.signed);
  assert.deepEqual(await readFile(join(f.dataDir,'upload-secret')),secret);
 }finally{restarted.closeAllConnections();restarted.close();await once(restarted,'close');}
 const small=await fixture(t,{limits:{maxStorageBytes:1}});assert.equal((await small.command('reserve',{manifest:small.release().signed})).status,503);
});
