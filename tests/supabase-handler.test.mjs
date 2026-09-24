import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {createCheckHandler,createPublishHandler} from '../providers/supabase/functions/_shared/handlers.ts';
import {signJws} from '../cli/crypto.mjs';
const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const trust={appId:'app.example.demo',environment:'production',backendContract:1,keyId:'synthetic',publicJwk:keys.publicKey.export({format:'jwk'}),artifactBaseUrl:'https://updates.example.invalid/artifacts'};
const selector={platform:'ios',channel:'internal',runtime:'a'.repeat(64)};
const request=body=>new Request('https://updates.example.invalid/check',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
function manifest(){return{protocol:1,appId:trust.appId,environment:trust.environment,backendContract:1,...selector,sequence:1,action:'withdraw',rollout:100,releaseId:randomUUID(),version:'1.0.1',issuedAt:new Date().toISOString()};}
function command(action,body){const iat=Math.floor(Date.now()/1000);return signJws({protocol:1,appId:trust.appId,aud:'direct-ota-publish',action,iat,exp:iat+60,nonce:randomUUID(),body},keys.privateKey,trust.keyId,'DIRECT-OTA-PUBLISH');}
test('random valid runtimes coalesce into one bounded catalog read and failures cool down',async()=>{
 let calls=0,now=1000;const signed=signJws(manifest(),keys.privateKey,trust.keyId);
 const handler=createCheckHandler({trust,now:()=>now,catalog:async()=>{calls++;return [{...selector,manifest:signed}];}});
 const responses=await Promise.all(Array.from({length:50},(_,i)=>handler(request({...selector,runtime:i.toString(16).padStart(64,'0')}))));
 assert(responses.every(response=>response.status===200));assert.equal(calls,1);
 assert.equal((await(await handler(request(selector))).json()).manifest,signed);
 now+=16000;await handler(request(selector));assert.equal(calls,2);
 let failures=0;const failing=createCheckHandler({trust,now:()=>now,catalog:async()=>{failures++;throw Error('sensitive database detail');}});
 for(let i=0;i<4;i++)assert.equal((await failing(request(selector))).status,503);assert.equal(failures,1);
});
test('catalog admission rejects before persistence, and metadata limits reject malformed requests',async()=>{
 let calls=0;const handler=createCheckHandler({trust,requestsPerMinute:1,catalog:async()=>{calls++;return[];}});
 assert.equal((await handler(request(selector))).status,200);assert.equal((await handler(request(selector))).status,429);assert.equal(calls,1);
 const normal=createCheckHandler({trust,catalog:async()=>{throw Error('must not call');}});
 assert.equal((await normal(request({...selector,extra:true}))).status,400);assert.equal((await normal(request({runtime:'x'.repeat(1000)}))).status,413);
});
test('publish rejects unsigned and wrong-purpose commands before RPC and allows direct signed withdrawal',async()=>{
 let calls=0;const seen=[];const handler=createPublishHandler({trust,command:async args=>{calls++;seen.push(args);return {sequence:1,releaseId:args.p_payload.releaseId};},inspect:async()=>{throw Error('withdrawal must not inspect');},upload:async()=>{throw Error('withdrawal must not upload');}});
 assert.equal((await handler(request({command:'unsigned'}))).status,401);
 const m=manifest(),signed=signJws(m,keys.privateKey,trust.keyId);
 assert.equal((await handler(request({command:signed}))).status,401);assert.equal(calls,0);
 const response=await handler(request({command:command('promote',{manifest:signed,expectedSequence:0})}));assert.equal(response.status,200);assert.equal(calls,1);assert.equal(seen[0].p_verified_sha256,null);assert.equal(seen[0].p_payload.action,'withdraw');
});
test('promotion refuses failed artifact digest and forwards only verified hash/size',async()=>{
 let calls=0,valid=false;const m=manifest(),hash='b'.repeat(64),path=`ios/${selector.runtime}/${m.releaseId}/${hash}.zip`;
 m.action='release';m.artifact={path,url:trust.artifactBaseUrl+'/'+path,sha256:hash,bytes:10,unpackedBytes:20,files:1,checksum:Buffer.alloc(256).toString('base64'),sessionKey:Buffer.alloc(16).toString('base64')+':'+Buffer.alloc(256).toString('base64')};
 const signed=signJws(m,keys.privateKey,trust.keyId),handler=createPublishHandler({trust,command:async args=>{calls++;assert.equal(args.p_verified_sha256,hash);assert.equal(args.p_verified_bytes,10);return{};},inspect:async()=>valid,upload:async()=>{throw Error('no upload');}});
 assert.equal((await handler(request({command:command('promote',{manifest:signed,expectedSequence:0})}))).status,400);assert.equal(calls,0);
 valid=true;assert.equal((await handler(request({command:command('promote',{manifest:signed,expectedSequence:0})}))).status,200);assert.equal(calls,1);
});
