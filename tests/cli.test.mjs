import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, stat, writeFile, mkdir, rm, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {initProject,readConfig,readIdentity} from '../cli/config.mjs';
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
test('upload destinations cannot redirect credentials to another host',()=>{
 const config={uploadOrigins:['https://storage.example.invalid']};
 validateUpload(config,{method:'PUT',url:'https://storage.example.invalid/upload?token=synthetic',headers:{'x-upsert':'false'}});
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
 await symlink('index.html',join(root,'web/link.html'));assert.throws(()=>run('link.zip'));await rm(join(root,'web/link.html'));
 await writeFile(join(root,'web/large.bin'),Buffer.alloc(26214401));assert.throws(()=>run('large.zip'));
});
