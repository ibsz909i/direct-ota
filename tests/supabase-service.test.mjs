import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,createHash} from 'node:crypto';
import {service} from '../providers/supabase/functions/_shared/service.ts';
test('Supabase REST adapter scopes upload capabilities and checks actual object digest',async t=>{
 const signing=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),base='https://project.example.invalid';
 const trust={appId:'app.example.demo',environment:'production',backendContract:1,keyId:'synthetic',publicJwk:signing.publicKey.export({format:'jwk'}),artifactBaseUrl:base+'/storage/v1/object/public/direct-ota'};
 const priorDeno=globalThis.Deno,priorFetch=globalThis.fetch;
 t.after(()=>{globalThis.Deno=priorDeno;globalThis.fetch=priorFetch;});
 const env={OTA_TRUST_JSON:JSON.stringify(trust),SUPABASE_URL:base,SUPABASE_SERVICE_ROLE_KEY:'synthetic-server-only-secret'};
 globalThis.Deno={env:{get:key=>env[key]}};
 const bytes=Buffer.from('synthetic ciphertext'),sha256=createHash('sha256').update(bytes).digest('hex'),path=`ios/${'a'.repeat(64)}/11111111-1111-4111-8111-111111111111/${sha256}.zip`;
 let badHash=false,badHost=false;
 globalThis.fetch=async(url,options)=>{
  assert.equal(options.redirect,'error');
  if(url.includes('/object/upload/sign/')){
   assert.equal(options.method,'POST');assert.equal(options.headers.Authorization,'Bearer synthetic-server-only-secret');assert.deepEqual(JSON.parse(options.body),{});assert.equal(options.headers['x-upsert'],undefined);
   return Response.json({url:badHost?'https://evil.example.invalid/?token=synthetic':'/object/upload/sign/direct-ota/'+path+'?token=synthetic'});
  }
  assert.equal(url,trust.artifactBaseUrl+'/'+path);assert.equal(options.headers.Authorization,undefined);
  return new Response(badHash?Buffer.alloc(bytes.length):bytes,{headers:{'Content-Length':String(bytes.length)}});
 };
 const backend=service(),upload=await backend.upload(path);
 assert.equal(upload.url,base+'/storage/v1/object/upload/sign/direct-ota/'+path+'?token=synthetic');assert.equal(upload.method,'PUT');assert.equal(upload.headers['x-upsert'],'false');assert.equal(upload.headers.Authorization,undefined);
 const artifact={path,url:trust.artifactBaseUrl+'/'+path,sha256,bytes:bytes.length};
 assert.equal(await backend.inspect(artifact),true);badHash=true;assert.equal(await backend.inspect(artifact),false);
 badHost=true;await assert.rejects(backend.upload(path));
});
