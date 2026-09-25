import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, mkdir, readFile, writeFile, rm, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {randomBytes, randomUUID, createHash} from 'node:crypto';
import {initProject, readIdentity} from '../cli/config.mjs';
import {exportProvider} from '../cli/provider.mjs';
import {writeNativeConfig} from '../cli/native.mjs';
import {prepare, upload, promote, instruction} from '../cli/releases.mjs';
import {command} from '../cli/transport.mjs';
import {signJws} from '../cli/crypto.mjs';
import {validateManifest} from '../src/protocol.ts';

const run = promisify(execFile);
const wrangler = resolve('node_modules/.bin/wrangler');

async function freePort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('Cloudflare Worker publishes, serves ranges, rejects unauthorized writes and rolls back', {timeout: 90000}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'direct-ota-cloudflare-'));
  const service = join(root, 'worker');
  const persistence = join(root, 'state');
  const key = join(root, 'tls.key'), cert = join(root, 'tls.crt');
  let worker;
  const port = await freePort();
  const proxy = https.createServer();
  t.after(async () => {
    if (worker) { worker.kill('SIGTERM'); await new Promise(resolve => worker.once('exit', resolve)); }
    await new Promise(resolve => proxy.close(resolve));
    await rm(root, {recursive:true, force:true});
  });
  await run('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,
    '-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost']);
  proxy.setSecureContext({key:await readFile(key), cert:await readFile(cert)});
  proxy.on('request', (req, res) => {
    const upstream = http.request({host:'127.0.0.1', port, path:req.url, method:req.method, headers:req.headers}, response => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
    });
    upstream.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const base = `https://localhost:${proxy.address().port}`;
  const config = await initProject(root, {appId:'app.example.cloudflare', baseUrl:base, provider:'cloudflare',
    webDir:'www', runtimeInputs:['native-source.txt']});
  config.limits={archiveBytes:20*1024*1024,unpackedBytes:100*1024*1024,files:5000};
  await writeFile(join(root,'direct-ota.config.json'),JSON.stringify(config));
  const identity = await readIdentity(root, config);
  await exportProvider('cloudflare', service);
  const workerConfig = JSON.parse((await readFile(join(service,'wrangler.jsonc'),'utf8')).replace(/^\s*\/\/.*$/gm,''));
  workerConfig.d1_databases[0].database_id = '00000000-0000-4000-8000-000000000001';
  workerConfig.vars.OTA_EVENTS_ENABLED = 'true';
  await writeFile(join(service,'wrangler.jsonc'), JSON.stringify(workerConfig));
  await writeFile(join(service,'.dev.vars'), `OTA_TRUST_JSON='${JSON.stringify(config)}'\nOTA_UPLOAD_SECRET='${randomBytes(32).toString('base64')}'\n`, {mode:0o600});
  await mkdir(persistence);
  await run(wrangler, ['d1','migrations','apply','DB','--local','--config',join(service,'wrangler.jsonc'),
    '--persist-to',persistence], {cwd:service, timeout:30000});
  worker = spawn(wrangler, ['dev','--local','--ip','127.0.0.1','--port',String(port),
    '--config',join(service,'wrangler.jsonc'),'--persist-to',persistence,'--show-interactive-dev-session=false'],
  {cwd:service, stdio:['ignore','pipe','pipe']});
  let logs = '';
  worker.stdout.on('data', value => { logs += value.toString(); });
  worker.stderr.on('data', value => { logs += value.toString(); });
  const origin = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i=0;i<30;i++) {
    if (worker.exitCode !== null) break;
    try { const response = await fetch(origin+'/missing',{signal:AbortSignal.timeout(1000)}); await response.body?.cancel(); ready = true; break; }
    catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert.ok(ready, `Worker did not start: ${logs.slice(-3000)}`);
  assert.equal((await fetch(origin+'/publish',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
  assert.equal((await fetch(origin+'/upload',{method:'PUT',body:'bad'})).status,403);

  await symlink(resolve('node_modules'),join(root,'node_modules'),'dir');
  await writeFile(join(root,'package.json'),JSON.stringify({name:'synthetic-host',dependencies:{'@capgo/capacitor-updater':'8.51.25','@capacitor/app':'^8.0.0'}}));
  await writeFile(join(root,'native-source.txt'),'synthetic contract');
  await mkdir(join(root,'www'));
  await writeFile(join(root,'www/index.html'),'<main>Cloudflare release one</main>');
  await writeFile(join(root,'www/large.bin'),randomBytes(6*1024*1024));
  const {plugin}=writeNativeConfig(root,config,{channel:'internal'});
  await mkdir(join(root,'ios/App/App'),{recursive:true});
  await writeFile(join(root,'ios/App/App/capacitor.config.json'),JSON.stringify({plugins:{CapacitorUpdater:plugin}}));
  const oldCa = process.env.NODE_EXTRA_CA_CERTS;
  process.env.NODE_EXTRA_CA_CERTS = cert;
  try {
    // Use the public CLI in separate processes, so TLS trust is loaded at process start.
    const cli = async args => JSON.parse((await run(process.execPath,[resolve('cli/index.mjs'),...args,'--project',root],
      {env:{...process.env,NODE_EXTRA_CA_CERTS:cert},timeout:20000})).stdout);
    assert.equal((await cli(['status','--platform','ios'])).sequence,0);
    const release = join(root,'.direct-ota/release-one');
    await run(process.execPath,[resolve('cli/index.mjs'),'prepare','--platform','ios','--version','1.0.1',
      '--out',release,'--project',root],{env:{...process.env,NODE_EXTRA_CA_CERTS:cert},timeout:20000});
    const reserveJws = await readFile(join(release,'manifest.jws'),'utf8');
    const reserveIat = Math.floor(Date.now()/1000);
    const reserveCommand = signJws({protocol:1,appId:config.appId,aud:'direct-ota-publish',action:'reserve',
      iat:reserveIat,exp:reserveIat+60,nonce:randomUUID(),body:{manifest:reserveJws}},
      identity.signing,config.keyId,'DIRECT-OTA-PUBLISH');
    const reservation = await fetch(origin+'/publish',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({command:reserveCommand})});
    assert.equal(reservation.status,200);
    const capability = (await reservation.json()).upload;
    const uploadPath = new URL(capability.url).pathname;
    assert.equal(new URL(capability.url).search,'');
    const uploadHeaders = capability.headers;
    const encrypted = await readFile(join(release,'bundle.zip'));
    assert.equal((await fetch(origin+uploadPath,{method:'PUT',headers:{'Content-Type':'application/zip'},body:encrypted})).status,403);
    assert.equal((await fetch(origin+uploadPath+'?capability='+encodeURIComponent(uploadHeaders['X-Direct-OTA-Upload']),
      {method:'PUT',headers:uploadHeaders,body:encrypted})).status,403);
    assert.equal((await fetch(origin+uploadPath,{method:'PUT',headers:{...uploadHeaders,
      'X-Direct-OTA-Upload':uploadHeaders['X-Direct-OTA-Upload']+'x'},body:encrypted})).status,403);
    const altered = Buffer.from(encrypted); altered[0] ^= 1;
    assert.equal((await fetch(origin+uploadPath,{method:'PUT',headers:uploadHeaders,body:altered})).status,400);
    assert.equal((await fetch(origin+uploadPath,{method:'PUT',headers:uploadHeaders,body:encrypted})).status,201);
    assert.equal((await fetch(origin+uploadPath,{method:'PUT',headers:uploadHeaders,body:encrypted})).status,409);
    await run(process.execPath,[resolve('cli/index.mjs'),'upload','--release',release,'--project',root],
      {env:{...process.env,NODE_EXTRA_CA_CERTS:cert},timeout:20000});
    const promoteJws = await readFile(join(release,'manifest.jws'),'utf8');
    const iatPromote = Math.floor(Date.now()/1000);
    const signedPromote = signJws({protocol:1,appId:config.appId,aud:'direct-ota-publish',action:'promote',
      iat:iatPromote,exp:iatPromote+60,nonce:'22222222-2222-4222-8222-222222222222',
      body:{manifest:promoteJws,expectedSequence:0}},identity.signing,config.keyId,'DIRECT-OTA-PUBLISH');
    const promotedResponse = await fetch(origin+'/publish',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({command:signedPromote})});
    const promotedText = await promotedResponse.text();
    if (promotedResponse.status !== 200) {
      const diagnostic = await run(wrangler,['d1','execute','DB','--local','--config',join(service,'wrangler.jsonc'),
        '--persist-to',persistence,'--command','SELECT id,selector,sequence,promoted,expires,path FROM releases; SELECT * FROM heads;'],{cwd:service});
      assert.equal(promotedResponse.status,200,promotedText+' '+diagnostic.stdout+' '+logs.slice(-500));
    }
    assert.equal((await cli(['promote','--release',release])).sequence,1);
    const status = await cli(['status','--platform','ios']);
    assert.equal(status.sequence,1);
    const manifest = JSON.parse(await readFile(join(release,'release.json'),'utf8')).manifest;
    const remoteHistory=await cli(['history','--remote','--platform','ios','--limit','1']);
    assert.equal(remoteHistory.items[0].releaseId,manifest.releaseId);
    assert.equal(remoteHistory.nextCursor,null);
    const remoteInspect=await cli(['inspect','--remote','--release-id',manifest.releaseId]);
    assert.equal(remoteInspect.artifact.sha256,manifest.artifact.sha256);
    assert(manifest.artifact.bytes>5*1024*1024);
    const checks = await Promise.all(Array.from({length:200}, (_, i) => fetch(origin+'/check', {
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({platform:'ios',channel:'internal',runtime:i % 2 ? manifest.runtime : 'f'.repeat(64)}),
    }).then(async response => ({status:response.status,body:await response.json()}))));
    assert(checks.every(({status}) => status === 200));
    assert.equal(checks.filter(({body}) => body.manifest).length,100);
    const response = await fetch(origin+'/artifacts/'+manifest.artifact.path);
    assert.equal(response.status,200);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(createHash('sha256').update(bytes).digest('hex'),manifest.artifact.sha256);
    const part = await fetch(origin+'/artifacts/'+manifest.artifact.path,{headers:{Range:'bytes=5-19'}});
    assert.equal(part.status,206);
    assert.deepEqual(Buffer.from(await part.arrayBuffer()),bytes.subarray(5,20));
    assert.equal((await fetch(origin+'/artifacts/'+manifest.artifact.path,{headers:{Range:`bytes=${manifest.artifact.bytes}-`}})).status,416);
    assert.equal((await fetch(origin+'/artifacts/'+manifest.artifact.path,{method:'PUT',body:'overwrite'})).status,404);
    assert.equal((await cli(['rollout','--from',release,'--platform','ios','--channel','production','--rollout','1'])).sequence,1);
    let withdrawn;
    try { withdrawn = await cli(['withdraw','--platform','ios','--channel','production']); }
    catch (error) { assert.fail(String(error)+' '+logs.slice(-3000)); }
    assert.equal(withdrawn.sequence,2);
    assert.equal((await cli(['rollback','--from',release,'--platform','ios','--channel','production'])).sequence,3);
    const production = await cli(['status','--platform','ios','--channel','production']);
    assert.equal(production.sequence,3);
    const {artifact: _artifact, ...withoutArtifact} = manifest;
    const competing = await Promise.all([0,1].map(async () => {
      const candidate = validateManifest({...withoutArtifact,channel:'production',sequence:4,action:'withdraw',
        releaseId:randomUUID(),issuedAt:new Date().toISOString()},config);
      const signedManifest = signJws(candidate,identity.signing,config.keyId);
      const iat = Math.floor(Date.now()/1000);
      const signedCommand = signJws({protocol:1,appId:config.appId,aud:'direct-ota-publish',action:'promote',
        iat,exp:iat+60,nonce:randomUUID(),body:{manifest:signedManifest,expectedSequence:3}},
        identity.signing,config.keyId,'DIRECT-OTA-PUBLISH');
      const response = await fetch(origin+'/publish',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({command:signedCommand})});
      await response.body?.cancel();
      return response.status;
    }));
    assert.deepEqual(competing.sort(),[200,409]);
    const remote = await cli(['doctor','--remote','--platform','ios']);
    assert.equal(remote.sequence,1);
    assert(remote.checks.includes('artifact SHA-256 verified'));
    const conformance = await cli(['test-provider','--write']);
    assert(conformance.checks.includes('synthetic channel withdrawn'));
    const event = await fetch(origin+'/events',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({releaseId:conformance.releaseId,event:'download_failed',metrics:{durationMs:2400,bytes:1200,retries:2,connection:'cellular'}})});
    assert.equal(event.status,204);
    const secondEvent = await fetch(origin+'/events',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({releaseId:conformance.releaseId,event:'download_failed',metrics:{durationMs:3600,bytes:800,retries:1,connection:'wifi'}})});
    assert.equal(secondEvent.status,204);
    const health = await cli(['health','--release-id',conformance.releaseId]);
    assert.equal(health.counts.download_failed,2);
    assert.deepEqual(health.metrics.download_failed,{measured:2,durationMs:6000,bytes:2000,retries:3,maxDurationMs:3600,
      connections:{wifi:1,cellular:1,unknown:0}});
    const privateEvent = await fetch(origin+'/events',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({releaseId:conformance.releaseId,event:'ready',installationId:'private'})});
    assert.equal(privateEvent.status,400);
    const iat = Math.floor(Date.now()/1000);
    const signed = signJws({protocol:1,appId:config.appId,aud:'direct-ota-publish',action:'status',iat,
      exp:iat+60,nonce:'11111111-1111-4111-8111-111111111111',body:{platform:'ios',channel:'internal',runtime:manifest.runtime}},
      identity.signing,config.keyId,'DIRECT-OTA-PUBLISH');
    const first = await fetch(origin+'/publish',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({command:signed})});
    assert.equal(first.status,200);
    const replay = await fetch(origin+'/publish',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({command:signed})});
    assert.equal(replay.status,409);
  } finally {
    if (oldCa === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
    else process.env.NODE_EXTRA_CA_CERTS = oldCa;
  }
});
