import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, stat, writeFile, mkdir, rm, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createPrivateKey, createPublicKey} from 'node:crypto';
import {initProject,readConfig,readIdentity,validateConfig} from '../cli/config.mjs';
import {validateUpload, boundedJson, command} from '../cli/transport.mjs';
import {verifyPublishCommand} from '../src/protocol.ts';
async function fixture(t) {const p=await mkdtemp(join(tmpdir(),'direct-ota-test-'));t.after(()=>rm(p,{recursive:true,force:true}));return p;}
test('init creates a private matching identity and never overwrites it',async t=>{
 const root=await fixture(t),config=await initProject(root,{appId:'app.example.demo',baseUrl:'https://updates.example.invalid'});
 await readIdentity(root,await readConfig(root));
 assert.equal((await stat(join(root,'.direct-ota/identity.json'))).mode&0o777,0o600);
 assert.doesNotMatch(await readFile(join(root,'direct-ota.config.json'),'utf8'),/PRIVATE KEY|"d"\s*:/);
 assert.match(await readFile(join(root,'.gitignore'),'utf8'),/\.direct-ota\//);
 await assert.rejects(initProject(root,{appId:config.appId,baseUrl:'https://updates.example.invalid'}));
});
test('public bundle configuration rejects private and mixed key encodings without rewriting them',async t=>{
 const root=await fixture(t),config=await initProject(root,{appId:'app.example.demo',baseUrl:'https://updates.example.invalid'});
 const identity=await readIdentity(root,config),privateKey=createPrivateKey(identity.bundle);
 const before=await readFile(join(root,'direct-ota.config.json'),'utf8');
 for(const bundlePublicKey of [
  identity.bundle,
  privateKey.export({type:'pkcs1',format:'pem'}),
  privateKey.export({type:'pkcs8',format:'pem',cipher:'aes-256-cbc',passphrase:'synthetic-test-only'}),
  privateKey.export({type:'pkcs8',format:'der'}),
  {key:identity.bundle,format:'pem'},
  {key:privateKey.export({type:'pkcs8',format:'der'}),format:'der',type:'pkcs8'},
  identity.bundle.replaceAll('PRIVATE KEY','PUBLIC KEY'),
  config.bundlePublicKey+identity.bundle,
  identity.bundle+config.bundlePublicKey,
 ]) {
  const supplied=Object.freeze({...config,bundlePublicKey});
  assert.throws(()=>validateConfig(supplied),/Bundle key must/);
  assert.equal(supplied.bundlePublicKey===bundlePublicKey,true);
 }
 for(const bundlePublicKey of [config.bundlePublicKey,createPublicKey(identity.bundle).export({type:'pkcs1',format:'pem'})]) {
  const supplied=Object.freeze({...config,bundlePublicKey});
  assert.equal(validateConfig(supplied)===supplied,true);
 }
 assert.equal(await readFile(join(root,'direct-ota.config.json'),'utf8'),before);
 await readIdentity(root,await readConfig(root));
});
test('public manifest JWK rejects private parameters and unrecognized material',async t=>{
 const root=await fixture(t),config=await initProject(root,{appId:'app.example.demo',baseUrl:'https://updates.example.invalid'});
 const identity=await readIdentity(root,config);
 for(const publicJwk of [
  createPrivateKey(identity.signing).export({format:'jwk'}),
  {...config.publicJwk,d:null},
  {...config.publicJwk,d:undefined},
  {...config.publicJwk,p:'synthetic-private-parameter'},
  {...config.publicJwk,key:identity.signing},
  {...config.publicJwk,key_ops:['sign']},
  {...config.publicJwk,kid:identity.signing},
  {...config.publicJwk,x:identity.signing},
  identity.signing,
 ]) assert.throws(()=>validateConfig({...config,publicJwk}),/Manifest key must/);
 const publicJwk=Object.freeze({...config.publicJwk,alg:'ES256',use:'sig',key_ops:['verify'],kid:'synthetic-key',ext:true});
 const supplied=Object.freeze({...config,publicJwk});
 assert.equal(validateConfig(supplied)===supplied,true);
 assert.equal(supplied.publicJwk===publicJwk,true);
});
test('upload destinations cannot redirect credentials to another host',()=>{
 const config={uploadOrigins:['https://storage.example.invalid']};
 validateUpload(config,{method:'PUT',url:'https://storage.example.invalid/upload?token=synthetic',headers:{'x-upsert':'false'}});
 validateUpload(config,{method:'PUT',url:'https://storage.example.invalid/upload',headers:{'X-Direct-OTA-Upload':'synthetic.capability'}});
 assert.throws(()=>validateUpload(config,{method:'PUT',url:'https://storage.example.invalid/other',headers:{'X-Direct-OTA-Upload':'synthetic.capability'}}));
 assert.throws(()=>validateUpload(config,{method:'PUT',url:'https://storage.example.invalid/upload?logged=1',headers:{'X-Direct-OTA-Upload':'synthetic.capability'}}));
 for(const bad of [{method:'POST',url:'https://storage.example.invalid/upload'},{method:'PUT',url:'https://evil.invalid/upload'},{method:'PUT',url:'http://storage.example.invalid/upload'},{method:'PUT',url:'https://storage.example.invalid/upload',headers:{Authorization:'secret'}}]) assert.throws(()=>validateUpload(config,bad));
});
test('metadata responses are bounded',async()=>{await assert.rejects(boundedJson(new Response('x'.repeat(33000))));});
test('transport retries use fresh signed nonces and no redirect following',async t=>{
 const root=await fixture(t),config=await initProject(root,{appId:'app.example.demo',baseUrl:'https://updates.example.invalid'}),identity=await readIdentity(root,config);const nonces=[];
 const result=await command(config,identity,'status',{},async(url,options)=>{
  assert.equal(options.redirect,'error');const c=await verifyPublishCommand(JSON.parse(options.body).command,config);nonces.push(c.nonce);
  return nonces.length===1?new Response('',{status:503}):Response.json({sequence:0,manifest:null});
 });assert.equal(result.sequence,0);assert.equal(new Set(nonces).size,2);
});
test('archive scanner excludes credentials, maps, links and oversized files',async t=>{
 const root=await fixture(t);await mkdir(join(root,'web'));await writeFile(join(root,'web/index.html'),'<main>Test</main>');
 const run=dest=>execFileSync('python3',['cli/package.py',join(root,'web'),join(root,dest)],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
 assert.equal(JSON.parse(run('good.zip')).files,1);
 await writeFile(join(root,'web/app.map'),'{}');assert.throws(()=>run('map.zip'));await rm(join(root,'web/app.map'));
 await writeFile(join(root,'web/app.js'),'-----BEGIN PRIVATE KEY-----');assert.throws(()=>run('key.zip'));await rm(join(root,'web/app.js'));
 await writeFile(join(root,'web/cafe\u0301.html'),'Unicode alias');assert.throws(()=>run('unicode.zip'));await rm(join(root,'web/cafe\u0301.html'));
 await writeFile(join(root,'web/bad\nname.html'),'Control character');assert.throws(()=>run('control.zip'));await rm(join(root,'web/bad\nname.html'));
 await symlink('index.html',join(root,'web/link.html'));assert.throws(()=>run('link.zip'));await rm(join(root,'web/link.html'));
 await writeFile(join(root,'web/large.bin'),Buffer.alloc(26214401));assert.throws(()=>run('large.zip'));
});

test('project scanner markers cannot disable built-in credential checks',async t=>{
 const root=await fixture(t);await mkdir(join(root,'web'));
 await writeFile(join(root,'web/index.html'),'<main>MY_INTERNAL_MARKER</main>');
 const policy=join(root,'scanner.json');
 const run=dest=>execFileSync('python3',['cli/package.py',join(root,'web'),join(root,dest),policy],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
 await writeFile(policy,JSON.stringify({deny:['MY_INTERNAL_MARKER']}));
 assert.throws(()=>run('blocked.zip'));
 await writeFile(policy,JSON.stringify({deny:['MY_INTERNAL_MARKER'],allowFiles:['index.html']}));
 assert.equal(JSON.parse(run('allowed.zip')).files,1);
 await writeFile(join(root,'web/index.html'),'-----BEGIN PRIVATE KEY-----');
 assert.throws(()=>run('secret.zip'));
 const config=await initProject(join(root,'host'),{appId:'app.example.demo',baseUrl:'https://updates.example.invalid'});
 assert.throws(()=>validateConfig({...config,scanner:{deny:['x']}}),/scanner/);
 assert.throws(()=>validateConfig({...config,scanner:{allowFiles:['../outside']}}),/scanner/);
});
