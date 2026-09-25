import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, randomUUID} from 'node:crypto';
import {verifyManifest, verifyPublishCommand, validateManifest, validateTrust} from '../src/protocol.ts';
import {signJws} from '../cli/crypto.mjs';
const key = generateKeyPairSync('ec', {namedCurve: 'prime256v1'});
const trust = {appId:'app.example.demo', environment:'production', backendContract:1, artifactBaseUrl:'https://updates.example.invalid/artifacts', keyId:'test', publicJwk:key.publicKey.export({format:'jwk'})};
const manifest = () => ({protocol:1,appId:trust.appId,environment:trust.environment,backendContract:1,platform:'ios',channel:'internal',runtime:'a'.repeat(64),sequence:1,action:'withdraw',rollout:100,releaseId:randomUUID(),version:'1.0.0',issuedAt:new Date().toISOString()});
test('signed manifest binds identity, environment, runtime and purpose', async () => {
 const m=manifest(), jws=signJws(m,key.privateKey,trust.keyId);
 assert.deepEqual(await verifyManifest(jws,trust,{runtime:m.runtime}),m);
 for (const bad of [{...trust,appId:'app.other'}, {...trust,environment:'staging'}, {...trust,keyId:'other'}]) await assert.rejects(verifyManifest(jws,bad));
 await assert.rejects(verifyManifest(jws,trust,{runtime:'b'.repeat(64)}));
 await assert.rejects(verifyManifest(signJws(m,key.privateKey,trust.keyId,'OTHER'),trust));
 await assert.rejects(verifyManifest(jws.slice(0,-10)+'aaaaaaaaaa',trust));
 const other=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
 await assert.rejects(verifyManifest(signJws(m,other.privateKey,trust.keyId),trust));
});
test('a native-pinned key ring accepts old and next release keys but only the active publisher', async () => {
 const next=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
 const nextJwk=next.publicKey.export({format:'jwk'});
 const keys=[{keyId:'test',publicJwk:trust.publicJwk},{keyId:'next',publicJwk:nextJwk}];
 const rotated={...trust,keyId:'next',publicJwk:nextJwk,trustedKeys:keys};
 const m=manifest();
 assert.deepEqual(await verifyManifest(signJws(m,key.privateKey,'test'),rotated),m);
 assert.deepEqual(await verifyManifest(signJws(m,next.privateKey,'next'),rotated),m);
 await assert.rejects(verifyManifest(signJws(m,key.privateKey,'unknown'),rotated));
 const iat=Math.floor(Date.now()/1000);
 const command={protocol:1,appId:trust.appId,aud:'direct-ota-publish',action:'status',iat,exp:iat+60,nonce:randomUUID(),body:{}};
 await assert.rejects(verifyPublishCommand(signJws(command,key.privateKey,'test','DIRECT-OTA-PUBLISH'),rotated));
 await verifyPublishCommand(signJws(command,next.privateKey,'next','DIRECT-OTA-PUBLISH'),rotated);
 assert.throws(()=>validateTrust({...rotated,trustedKeys:[keys[0],keys[0]]}));
 assert.throws(()=>validateTrust({...rotated,trustedKeys:[keys[0],{keyId:'next',publicJwk:next.privateKey.export({format:'jwk'})}]}));
});
test('rejects malformed fields, invalid dates and secret-bearing trust', () => {
 for (const values of [{sequence:0},{sequence:1.5},{rollout:101},{version:'01.0.0'},{issuedAt:'2026-02-30T00:00:00Z'},{extra:1}]) assert.throws(()=>validateManifest({...manifest(),...values},trust));
 for(const url of ['http://updates.example.invalid/artifacts','https://updates.example.invalid/artifacts/','https://user:pass@updates.example.invalid/artifacts','https://updates.example.invalid/artifacts?token=x']) assert.throws(()=>validateTrust({...trust,artifactBaseUrl:url}));
 assert.throws(()=>validateTrust({...trust,publicJwk:key.privateKey.export({format:'jwk'})}));
});
test('artifact path and URL are exact and bounded', () => {
 const m=manifest(); m.action='release';
 const hash='c'.repeat(64),path=`ios/${m.runtime}/${m.releaseId}/${hash}.zip`;
 m.artifact={path,url:trust.artifactBaseUrl+'/'+path,sha256:hash,bytes:100,unpackedBytes:200,files:2,checksum:Buffer.alloc(256).toString('base64'),sessionKey:Buffer.alloc(16).toString('base64')+':'+Buffer.alloc(256).toString('base64')};
 validateManifest(m,trust);
 for(const change of [{url:m.artifact.url+'?redirect=evil'},{path:'../other'},{bytes:5242881},{files:1001},{unpackedBytes:26214401},{checksum:'bad'}]) assert.throws(()=>validateManifest({...m,artifact:{...m.artifact,...change}},trust));
 assert.equal(validateManifest({...m,mode:'background'},trust).mode,'background');
 assert.equal(validateManifest({...m,mode:'required'},trust).mode,'required');
 for(const mode of ['silent','',null,1])assert.throws(()=>validateManifest({...m,mode},trust));
 assert.throws(()=>validateManifest({...manifest(),mode:'background'},trust));
});
test('larger archives require matching native-pinned limits and remain bounded', () => {
 const m=manifest();m.action='release';
 const hash='d'.repeat(64),path=`ios/${m.runtime}/${m.releaseId}/${hash}.zip`;
 m.artifact={path,url:trust.artifactBaseUrl+'/'+path,sha256:hash,bytes:6*1024*1024,unpackedBytes:30*1024*1024,files:1200,checksum:Buffer.alloc(256).toString('base64'),sessionKey:Buffer.alloc(16).toString('base64')+':'+Buffer.alloc(256).toString('base64')};
 assert.throws(()=>validateManifest(m,trust));
 const larger={...trust,limits:{archiveBytes:20*1024*1024,unpackedBytes:100*1024*1024,files:5000}};
 assert.equal(validateManifest(m,larger).artifact.bytes,m.artifact.bytes);
 for(const limits of [
   {archiveBytes:51*1024*1024,unpackedBytes:100*1024*1024,files:5000},
   {archiveBytes:20*1024*1024,unpackedBytes:25*1024*1024,files:5001},
   {archiveBytes:30*1024*1024,unpackedBytes:25*1024*1024,files:1000},
 ]) assert.throws(()=>validateTrust({...trust,limits}));
 assert.throws(()=>validateManifest({...m,artifact:{...m.artifact,bytes:larger.limits.archiveBytes+1}},larger));
});
test('signed compound artifacts bind a bounded patch and complete encrypted bundle', () => {
 const m=manifest();m.action='release';
 const hash='d'.repeat(64),path=`ios/${m.runtime}/${m.releaseId}/${hash}.zip`;
 const checksum=Buffer.alloc(256).toString('base64'),sessionKey=Buffer.alloc(16).toString('base64')+':'+Buffer.alloc(256).toString('base64');
 const delta={fromSha256:'a'.repeat(64),baseChecksum:'b'.repeat(64),fullBytes:100,fullSha256:'c'.repeat(64),
   offset:100,bytes:80,sha256:'e'.repeat(64),checksum,sessionKey};
 m.artifact={path,url:trust.artifactBaseUrl+'/'+path,sha256:hash,bytes:180,unpackedBytes:200,files:1,checksum,sessionKey,delta};
 assert.deepEqual(validateManifest(m,trust).artifact.delta,delta);
 for(const bad of [{offset:99},{bytes:100},{sha256:'bad'},{baseChecksum:'bad'},{extra:true}])
   assert.throws(()=>validateManifest({...m,artifact:{...m.artifact,delta:{...delta,...bad}}},trust));
 assert.throws(()=>validateManifest({...m,artifact:{...m.artifact,bytes:181}},trust));
});
test('publishing commands require scoped purpose and a short expiry', async () => {
 const iat=Math.floor(Date.now()/1000),body={protocol:1,appId:trust.appId,aud:'direct-ota-publish',action:'status',iat,exp:iat+60,nonce:randomUUID(),body:{}};
 const signed=v=>signJws(v,key.privateKey,trust.keyId,'DIRECT-OTA-PUBLISH');
 await verifyPublishCommand(signed(body),trust);
 for(const change of [{exp:iat+3600},{iat:iat-120},{aud:'other'},{nonce:'x'},{action:'delete'},{body:null}]) await assert.rejects(verifyPublishCommand(signed({...body,...change}),trust));
 await assert.rejects(verifyPublishCommand(signJws(body,key.privateKey,trust.keyId),trust));
});
