import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import {mkdtemp,mkdir,readFile,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {createOtaServer} from '../providers/node/server.mjs';
import {writeNativeConfig} from '../cli/native.mjs';
const exec=promisify(execFile);

test('CLI publishes, downloads, rolls out, rolls back and withdraws through HTTPS', {timeout:60000}, async t=>{
 const root=await mkdtemp(join(tmpdir(),'direct-ota-publish-'));

 const key=join(root,'tls.key'),cert=join(root,'tls.crt');
 await exec('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost']);
 let upstream;
 const proxy=https.createServer({key:await readFile(key),cert:await readFile(cert)},(req,res)=>{
  const request=http.request({host:'127.0.0.1',port:upstream.address().port,path:req.url,method:req.method,headers:req.headers},response=>{res.writeHead(response.statusCode,response.headers);response.pipe(res);});
  request.on('error',()=>{res.writeHead(502);res.end();});req.pipe(request);
 });
 await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
 t.after(async()=>{
  await new Promise(r=>proxy.close(r));
  if(upstream) await new Promise(r=>upstream.close(r));
  await rm(root,{recursive:true,force:true});
 });
 const base=`https://localhost:${proxy.address().port}`;
 const cli=async(args)=>{
  const {stdout}=await exec(process.execPath,[resolve('cli/index.mjs'),...args,'--project',root],{env:{...process.env,NODE_EXTRA_CA_CERTS:cert},maxBuffer:65536});return stdout.trim();
 };
 await cli(['init','--app-id','app.example.integration','--base-url',base]);
 await symlink(resolve('node_modules'),join(root,'node_modules'),'dir');
 await writeFile(join(root,'package.json'),JSON.stringify({name:'synthetic-capacitor-host',dependencies:{'@capgo/capacitor-updater':'8.51.25','@capacitor/app':'^8.0.0'}}));
 await writeFile(join(root,'capacitor.config.json'),JSON.stringify({appId:'app.example.integration',appName:'Demo',webDir:'www'}));
 const config=JSON.parse(await readFile(join(root,'direct-ota.config.json'),'utf8'));config.webDir='www';config.runtimeInputs=['native-source.txt'];
 await writeFile(join(root,'direct-ota.config.json'),JSON.stringify(config));await writeFile(join(root,'native-source.txt'),'synthetic native contract');
 await mkdir(join(root,'www'));await writeFile(join(root,'www/index.html'),'<main>Release one</main>');
 const {plugin}=writeNativeConfig(root,config,{channel:'internal'});
 await mkdir(join(root,'ios/App/App'),{recursive:true});await writeFile(join(root,'ios/App/App/capacitor.config.json'),JSON.stringify({plugins:{CapacitorUpdater:plugin}}));
 upstream=await createOtaServer({trust:config,dataDir:join(root,'service')});await new Promise(r=>upstream.listen(0,'127.0.0.1',r));

 assert.match(await cli(['doctor']),/configuration match/);
 assert.equal(JSON.parse(await cli(['status','--platform','ios'])).sequence,0);
 const release=join(root,'.direct-ota/release-one');
 await cli(['prepare','--platform','ios','--version','1.0.1-beta.1+build.4','--out',release]);
 await cli(['upload','--release',release]);
 // Repeated uploads cannot replace an immutable file and remain safe to retry.
 await cli(['upload','--release',release]);
 const promoted=JSON.parse(await cli(['promote','--release',release]));assert.equal(promoted.sequence,1);
 assert.equal(JSON.parse(await cli(['promote','--release',release])).sequence,1);
 const {manifest}=JSON.parse(await readFile(join(release,'release.json'),'utf8'));
 const ca=await readFile(cert);
 const downloaded=await new Promise((resolve,reject)=>https.get(manifest.artifact.url,{ca},response=>{
  assert.equal(response.statusCode,200);const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve(Buffer.concat(chunks)));response.on('error',reject);
 }).on('error',reject));
 assert.equal(createHash('sha256').update(downloaded).digest('hex'),manifest.artifact.sha256);
 assert.equal(JSON.parse(await cli(['rollout','--from',release,'--platform','ios','--channel','production','--rollout','1'])).sequence,1);
 assert.equal(JSON.parse(await cli(['rollout','--from',release,'--platform','ios','--channel','production','--rollout','100'])).sequence,2);
 assert.equal(JSON.parse(await cli(['rollback','--from',release,'--platform','ios','--channel','production'])).sequence,3);
 assert.equal(JSON.parse(await cli(['withdraw','--platform','ios','--channel','production'])).sequence,4);
 const status=JSON.parse(await cli(['status','--platform','ios','--channel','production']));
 assert.equal(status.sequence,4);
 assert.equal(JSON.parse(Buffer.from(status.manifest.split('.')[1],'base64url')).action,'withdraw');
});
