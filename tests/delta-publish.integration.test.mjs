import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import {mkdtemp,mkdir,readFile,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomBytes} from 'node:crypto';
import {createOtaServer} from '../providers/node/server.mjs';
import {writeNativeConfig} from '../cli/native.mjs';
import {readIdentity} from '../cli/config.mjs';
import {decryptBundle} from '../cli/crypto.mjs';
import {applyDelta} from '../cli/delta.mjs';

const exec=promisify(execFile);
const sha256=value=>createHash('sha256').update(value).digest('hex');

test('CLI publishes a compound artifact whose full and ranged delta reconstruct the same verified ZIP', {timeout:90000}, async t=>{
  const root=await mkdtemp(join(tmpdir(),'direct-ota-delta-'));
  const cert=join(root,'tls.crt');
  await exec('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(root,'tls.key'),'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost']);
  let upstream;
  const proxy=https.createServer({key:await readFile(join(root,'tls.key')),cert:await readFile(cert)},(request,response)=>{
    const target=http.request({host:'127.0.0.1',port:upstream.address().port,path:request.url,method:request.method,headers:request.headers},reply=>{
      response.writeHead(reply.statusCode,reply.headers);reply.pipe(response);
    });
    target.on('error',()=>{response.writeHead(502);response.end();});request.pipe(target);
  });
  await new Promise(done=>proxy.listen(0,'127.0.0.1',done));
  t.after(async()=>{
    await new Promise(done=>proxy.close(done));
    if(upstream)await new Promise(done=>upstream.close(done));
    await rm(root,{recursive:true,force:true});
  });
  const base=`https://localhost:${proxy.address().port}`;
  const cli=async args=>(await exec(process.execPath,[resolve('cli/index.mjs'),...args,'--project',root],{
    env:{...process.env,NODE_EXTRA_CA_CERTS:cert},maxBuffer:65536,
  })).stdout.trim();
  const get=async(url,range)=>new Promise((done,reject)=>{
    https.get(url,{ca:awaitedCert,headers:range?{Range:range}:{}},reply=>{
      const chunks=[];reply.on('data',chunk=>chunks.push(chunk));reply.on('end',()=>done({status:reply.statusCode,headers:reply.headers,bytes:Buffer.concat(chunks)}));reply.on('error',reject);
    }).on('error',reject);
  });
  const awaitedCert=await readFile(cert);
  await cli(['init','--app-id','app.example.delta','--base-url',base]);
  await symlink(resolve('node_modules'),join(root,'node_modules'),'dir');
  await writeFile(join(root,'package.json'),JSON.stringify({name:'delta-fixture',dependencies:{'@capgo/capacitor-updater':'8.51.25','@capacitor/app':'^8.0.0'}}));
  await writeFile(join(root,'capacitor.config.json'),JSON.stringify({appId:'app.example.delta',appName:'Demo',webDir:'www'}));
  const config=JSON.parse(await readFile(join(root,'direct-ota.config.json'),'utf8'));
  config.webDir='www';config.runtimeInputs=['native-source.txt'];
  await writeFile(join(root,'direct-ota.config.json'),JSON.stringify(config));
  await writeFile(join(root,'native-source.txt'),'stable native runtime');
  await mkdir(join(root,'www'));
  await writeFile(join(root,'www/index.html'),'<main>Version one</main>');
  await writeFile(join(root,'www/asset.bin'),randomBytes(512*1024));
  const {plugin}=writeNativeConfig(root,config,{channel:'internal'});
  await mkdir(join(root,'ios/App/App'),{recursive:true});
  await writeFile(join(root,'ios/App/App/capacitor.config.json'),JSON.stringify({plugins:{CapacitorUpdater:plugin}}));
  upstream=await createOtaServer({trust:config,dataDir:join(root,'service')});
  await new Promise(done=>upstream.listen(0,'127.0.0.1',done));

  const first=join(root,'.direct-ota','first');
  await cli(['prepare','--platform','ios','--version','1.0.0','--out',first]);
  await cli(['upload','--release',first]);
  assert.equal(JSON.parse(await cli(['promote','--release',first])).sequence,1);
  await writeFile(join(root,'www/index.html'),'<main>Version two</main>');
  const second=join(root,'.direct-ota','second');
  await cli(['prepare','--platform','ios','--version','1.0.1','--delta-from',first,'--out',second]);
  const current=JSON.parse(await readFile(join(second,'release.json'),'utf8')).manifest;
  const previous=JSON.parse(await readFile(join(first,'release.json'),'utf8')).manifest;
  const artifact=await readFile(join(second,'bundle.zip'));
  const delta=current.artifact.delta;
  assert(delta,'the mostly unchanged bundle should have a smaller delta');
  assert(delta.bytes<delta.fullBytes);
  assert.equal(sha256(artifact),current.artifact.sha256);
  assert.equal(sha256(artifact.subarray(0,delta.fullBytes)),delta.fullSha256);
  assert.equal(sha256(artifact.subarray(delta.offset)),delta.sha256);
  const identity=await readIdentity(root,config);
  const oldZip=decryptBundle(await readFile(join(first,'bundle.zip')),previous.artifact,identity.bundle);
  const fullZip=decryptBundle(artifact.subarray(0,delta.fullBytes),{...current.artifact,sha256:delta.fullSha256},identity.bundle);
  const patch=decryptBundle(artifact.subarray(delta.offset),delta,identity.bundle);
  assert.equal(sha256(oldZip),delta.baseChecksum);
  assert.deepEqual(applyDelta(oldZip,patch),fullZip);
  await cli(['upload','--release',second]);
  assert.equal(JSON.parse(await cli(['promote','--release',second])).sequence,2);
  const full=await get(current.artifact.url,`bytes=0-${delta.fullBytes-1}`);
  assert.equal(full.status,206);
  assert.equal(full.headers['content-range'],`bytes 0-${delta.fullBytes-1}/${artifact.length}`);
  assert.deepEqual(full.bytes,artifact.subarray(0,delta.fullBytes));
  const ranged=await get(current.artifact.url,`bytes=${delta.offset}-${artifact.length-1}`);
  assert.equal(ranged.status,206);
  assert.equal(ranged.headers['content-range'],`bytes ${delta.offset}-${artifact.length-1}/${artifact.length}`);
  assert.deepEqual(ranged.bytes,artifact.subarray(delta.offset));
  const entire=await get(current.artifact.url);
  assert.equal(entire.status,200);
  assert.equal(sha256(entire.bytes),current.artifact.sha256);
  assert((await cli(['doctor','--remote','--platform','ios'])).includes('artifact SHA-256 verified'));
  // An unrelated asset change cannot make the optimization inflate a release.
  await writeFile(join(root,'www/asset.bin'),randomBytes(512*1024));
  const third=join(root,'.direct-ota','third');
  await cli(['prepare','--platform','ios','--version','1.0.2','--delta-from',second,'--out',third]);
  const unrelated=JSON.parse(await readFile(join(third,'release.json'),'utf8')).manifest;
  assert.equal(unrelated.artifact.delta,undefined);
  assert.equal(sha256(await readFile(join(third,'bundle.zip'))),unrelated.artifact.sha256);
  const linked=join(root,'.direct-ota','linked');
  await symlink(second,linked,'dir');
  await assert.rejects(cli(['prepare','--platform','ios','--version','1.0.3','--delta-from',linked,
    '--out',join(root,'.direct-ota','linked-target')]),/regular release directory/);
  const changed=Buffer.from(await readFile(join(second,'bundle.zip')));changed[0]^=1;
  await writeFile(join(second,'bundle.zip'),changed);
  await assert.rejects(cli(['prepare','--platform','ios','--version','1.0.3','--delta-from',second,
    '--out',join(root,'.direct-ota','tampered-target')]),/Delta base artifact changed after signing/);
});
