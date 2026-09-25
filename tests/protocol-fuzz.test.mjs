import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {signJws} from '../cli/crypto.mjs';
import {validateManifest,verifyManifest} from '../src/protocol.ts';

const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const trust={appId:'app.example.fuzz',environment:'test',backendContract:1,keyId:'fuzz',
  publicJwk:keys.publicKey.export({format:'jwk'}),artifactBaseUrl:'https://updates.example.invalid/artifacts'};
const release=()=>{
  const runtime='a'.repeat(64),releaseId=randomUUID(),sha256='b'.repeat(64);
  const path=`ios/${runtime}/${releaseId}/${sha256}.zip`;
  return {protocol:1,appId:trust.appId,environment:trust.environment,backendContract:1,
    platform:'ios',channel:'internal',runtime,sequence:1,action:'release',rollout:100,releaseId,
    version:'1.0.0',issuedAt:new Date().toISOString(),artifact:{path,url:trust.artifactBaseUrl+'/'+path,
      sha256,bytes:1024,unpackedBytes:2048,files:2,checksum:Buffer.alloc(256).toString('base64'),
      sessionKey:Buffer.alloc(16).toString('base64')+':'+Buffer.alloc(256).toString('base64')}};
};
let state=0x4d595df4;
const next=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state;};

test('deterministic malformed manifest corpus never passes admission',()=>{
  const invalid=[
    m=>({...m,sequence:-(next()%1000)}),
    m=>({...m,sequence:1+(next()%1000)/1001}),
    m=>({...m,rollout:101+next()%1000}),
    m=>({...m,runtime:'a'.repeat(63)+String.fromCharCode(0x3a+next()%20)}),
    m=>({...m,version:`01.${next()%100}.0`}),
    m=>({...m,issuedAt:`2026-02-${String(30+next()%50).padStart(2,'0')}T00:00:00Z`}),
    m=>({...m,artifact:{...m.artifact,bytes:5242881+next()%100000}}),
    m=>({...m,artifact:{...m.artifact,files:1001+next()%10000}}),
    m=>({...m,artifact:{...m.artifact,path:`../${next()}.zip`}}),
    m=>({...m,artifact:{...m.artifact,url:`http://other.invalid/${next()}`}}),
    m=>({...m,artifact:{...m.artifact,sha256:'z'.repeat(64)}}),
    m=>({...m,[`extra_${next()}`]:true}),
  ];
  for(let i=0;i<1200;i++)assert.throws(()=>validateManifest(invalid[next()%invalid.length](release()),trust));
});

test('mutating every part of a signed instruction invalidates it',async()=>{
  const valid=signJws(release(),keys.privateKey,trust.keyId);
  assert.equal((await verifyManifest(valid,trust)).action,'release');
  const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  for(let i=0;i<256;i++){
    let at=next()%valid.length;if(valid[at]==='.')at=(at+1)%valid.length;
    const alternate=alphabet[(alphabet.indexOf(valid[at])+1+next()%63)%alphabet.length];
    const changed=valid.slice(0,at)+alternate+valid.slice(at+1);
    await assert.rejects(verifyManifest(changed,trust));
  }
});
