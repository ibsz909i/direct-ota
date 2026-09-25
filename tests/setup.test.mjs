import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, lstat, access, cp, symlink, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {guidedSetup} from '../cli/setup.mjs';
import {readConfig, readIdentity} from '../cli/config.mjs';
import {verifyCapacitorPlugins} from '../cli/native.mjs';
import {diagnoseProject} from '../cli/doctor.mjs';
import {finishSetup} from '../cli/finish-setup.mjs';
import {guidedDeploy} from '../cli/deploy.mjs';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'https://synthetic-project.supabase.co';

async function host(t) {
  const root = await mkdtemp(join(tmpdir(), 'direct-ota-setup-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(join(root, 'node_modules/@capacitor'), {recursive: true});
  await mkdir(join(root, 'node_modules/@capgo'), {recursive: true});
  for (const name of ['cli', 'core', 'app']) {
    await symlink(join(source, 'node_modules/@capacitor', name), join(root, 'node_modules/@capacitor', name), 'dir');
  }
  await cp(join(source, 'node_modules/@capgo/capacitor-updater'), join(root, 'node_modules/@capgo/capacitor-updater'), {recursive: true});
  await writeFile(join(root, 'package.json'), JSON.stringify({name: 'synthetic-setup-host',
    dependencies: {'direct-ota':'0.2.0','@capacitor/core':'8.1.0','@capacitor/app':'8.1.0','@capgo/capacitor-updater':'8.51.25'},
    devDependencies: {'@capacitor/cli':'8.4.3'}}));
  await writeFile(join(root, 'package-lock.json'), '{}');
  await writeFile(join(root, 'capacitor.config.json'), JSON.stringify({appId:'app.example.setup', appName:'Setup Test', webDir:'public-web'}));
  await mkdir(join(root, 'public-web'));
  await writeFile(join(root, 'public-web/index.html'), '<main>synthetic</main>');
  await mkdir(join(root, 'ios'));
  await writeFile(join(root, 'ios/Native.txt'), 'synthetic native input');
  await writeFile(join(root, '.gitignore'), 'node_modules/\n');
  return root;
}

test('setup preview detects the host and makes no local or remote changes', async t => {
  const root = await host(t);
  const result = await guidedSetup(root, {provider:'supabase',baseUrl:origin,plan:true});
  assert.equal(result.applied, false);
  assert.match(result.plan, /App: app\.example\.setup \(Capacitor 8; ios\)/);
  assert.match(result.plan, /Web directory: public-web/);
  assert.match(result.plan, /No migration, Edge Function, bucket, or release is deployed/);
  await assert.rejects(access(join(root, '.direct-ota')));
  await assert.rejects(access(join(root, 'ota-service')));
  assert.equal(await readFile(join(root, '.gitignore'), 'utf8'), 'node_modules/\n');
});

test('guided setup exports configured Supabase provider and private identity without overwrites', async t => {
  const root = await host(t);
  const result = await guidedSetup(root, {provider:'supabase',baseUrl:origin,yes:true});
  assert.equal(result.applied, true);
  const config = await readConfig(root);
  await readIdentity(root, config);
  assert.equal(config.appId, 'app.example.setup');
  assert.equal(config.webDir, 'public-web');
  assert.deepEqual(config.runtimeInputs, ['capacitor.config.json','package-lock.json','ios']);
  assert.equal((await lstat(join(root, '.direct-ota/identity.json'))).mode & 0o777, 0o600);
  assert.equal((await lstat(join(root, '.direct-ota/supabase-trust.env'))).mode & 0o777, 0o600);
  const env = await readFile(join(root, '.direct-ota/supabase-trust.env'), 'utf8');
  assert.deepEqual(JSON.parse(env.slice('OTA_TRUST_JSON='.length)), config);
  assert.doesNotMatch(env, /BEGIN PRIVATE KEY/);
  const sql = await readFile(join(root, 'ota-service/setup.sql'), 'utf8');
  assert.match(sql, new RegExp(config.keyId));
  assert.match(sql, /app\.example\.setup/);
  assert.match(sql, /synthetic-project\.supabase\.co/);
  assert.doesNotMatch(sql, /REPLACE_WITH|YOUR_PROJECT/);
  assert.match(await readFile(join(root, 'ota-service/functions/_shared/protocol.ts'), 'utf8'), /verifyManifest/);
  assert.ok(verifyCapacitorPlugins(root).ios.includes('@capgo/capacitor-updater'));
  assert.equal(JSON.parse(await readFile(join(root, 'direct-ota.capacitor.json'), 'utf8')).directOtaChannel, 'internal');
  assert.match(await readFile(join(root, '.gitignore'), 'utf8'), /\.direct-ota\//);
  await assert.rejects(guidedSetup(root, {provider:'supabase',baseUrl:origin,yes:true}), /already exists/);
});

test('guided setup exports a standalone Cloudflare Worker and private secrets', async t => {
  const root = await host(t);
  const origin = 'https://synthetic-ota.example.workers.dev';
  const result = await guidedSetup(root, {provider:'cloudflare', baseUrl:origin, yes:true});
  assert.equal(result.applied, true);
  const config = await readConfig(root);
  await readIdentity(root, config);
  assert.equal(config.checkUrl, origin + '/check');
  assert.equal(config.publishUrl, origin + '/publish');
  assert.equal(config.artifactBaseUrl, origin + '/artifacts');
  assert.deepEqual(config.uploadOrigins, [origin]);
  assert.deepEqual(await readFile(join(root, 'ota-service/src/protocol.ts'), 'utf8'),
    await readFile(join(source, 'src/protocol.ts'), 'utf8'));
  const trust = join(root, '.direct-ota/cloudflare-trust.json');
  const secret = join(root, '.direct-ota/cloudflare-upload-secret');
  for (const file of [trust, secret]) assert.equal((await lstat(file)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(trust, 'utf8')), config);
  assert.equal(Buffer.from((await readFile(secret, 'utf8')).trim(), 'base64').length, 32);
  assert.doesNotMatch(await readFile(join(root, 'ota-service/wrangler.jsonc'), 'utf8'), /BEGIN PRIVATE KEY/);
});

test('guided setup exports a standalone Firebase provider and private secrets', async t => {
  const root = await host(t);
  const baseUrl = 'https://synthetic-ota.web.app';
  const result = await guidedSetup(root, {provider:'firebase', baseUrl, yes:true});
  assert.equal(result.applied, true);
  const config = await readConfig(root);
  await readIdentity(root, config);
  assert.equal(config.artifactBaseUrl, baseUrl + '/artifacts');
  assert.deepEqual(await readFile(join(root, 'ota-service/functions/src/provider.ts'), 'utf8'),
    await readFile(join(source, 'src/provider.ts'), 'utf8'));
  for (const file of ['firebase-trust.json', 'firebase-upload-secret'])
    assert.equal((await lstat(join(root, '.direct-ota', file))).mode & 0o777, 0o600);
  assert.match(await readFile(join(root, 'ota-service/firestore.rules'), 'utf8'), /allow read, write: if false/);
});

test('setup rejects mismatched app identity, wrong provider, and unsafe output before writing', async t => {
  const root = await host(t);
  await assert.rejects(guidedSetup(root, {provider:'supabase',appId:'app.other',baseUrl:origin,yes:true}), /differs/);
  await assert.rejects(guidedSetup(root, {provider:'supabase',baseUrl:origin,out:'../outside',yes:true}), /inside the app/);
  await assert.rejects(guidedSetup(root, {provider:'unknown',baseUrl:origin,yes:true}), /supports --provider/);
  await assert.rejects(access(join(root, '.direct-ota')));
});

test('doctor reports each readiness gate and repairs only generated JSON host settings', async t => {
  const root = await host(t);
  await guidedSetup(root, {provider:'supabase',baseUrl:origin,yes:true});
  const config = await readConfig(root);
  const before = await diagnoseProject(root, config);
  assert.equal(before.ready, false);
  assert(before.checks.some(item => item.name === 'Host Capacitor settings' && !item.ok));
  const fixed = await diagnoseProject(root, config, {fix:true});
  assert(fixed.checks.some(item => item.name === 'Host Capacitor settings' && item.ok), JSON.stringify(fixed.checks));
  const sourceConfig = JSON.parse(await readFile(join(root, 'capacitor.config.json'), 'utf8'));
  assert.equal(sourceConfig.appName, 'Setup Test');
  assert.equal(sourceConfig.plugins.CapacitorUpdater.directOtaAppId, config.appId);
  assert.equal(fixed.ready, false); // Sync is still needed; --fix never fakes native readiness.
  await mkdir(join(root, 'ios/App/App'), {recursive:true});
  await writeFile(join(root, 'ios/App/App/capacitor.config.json'), JSON.stringify({plugins:sourceConfig.plugins}));
  assert.equal((await diagnoseProject(root, config)).ready, true);
  await writeFile(join(root,'direct-ota.capacitor.json'),'{invalid');
  const command=execFileSync(process.execPath,[join(source,'cli/index.mjs'),'doctor','--fix','--channel','internal',
    '--project',root],{encoding:'utf8'});
  assert.match(command,/Generated updater settings: repaired/);
  assert.equal((await diagnoseProject(root,config)).ready,true);
});

test('doctor repairs malformed generated settings only with an explicit channel and refuses runtime drift', async t => {
  const root = await host(t);
  await guidedSetup(root,{provider:'supabase',baseUrl:origin,yes:true});
  const config = await readConfig(root);
  await writeFile(join(root,'direct-ota.capacitor.json'),'{broken');
  const noChannel = await diagnoseProject(root,config,{fix:true});
  assert(noChannel.checks.some(item=>item.name==='Generated updater settings' && !item.ok));
  const fixed = await diagnoseProject(root,config,{fix:true,channel:'internal'});
  assert(fixed.checks.some(item=>item.name==='Generated updater settings' && item.ok));
  const recorded = await readFile(join(root,'direct-ota.runtime.json'),'utf8');
  await writeFile(join(root,'ios/Native.txt'),'different native input');
  const drift = await diagnoseProject(root,config,{fix:true,channel:'internal'});
  assert(drift.checks.some(item=>item.name==='Native runtime' && !item.ok));
  assert.equal(await readFile(join(root,'direct-ota.runtime.json'),'utf8'),recorded);
});

test('finish plan is read-only and apply scopes deployment after a stable native sync', async t => {
  const root = await host(t);
  const baseUrl = 'https://direct-ota-test.example.workers.dev';
  await guidedSetup(root, {provider:'cloudflare',baseUrl,yes:true});
  const workerFile = join(root,'ota-service/wrangler.jsonc');
  const worker = JSON.parse((await readFile(workerFile,'utf8')).replace(/^\s*\/\/.*$/gm,''));
  worker.name = 'direct-ota-test';
  worker.d1_databases[0].database_name = 'direct-ota-test';
  worker.d1_databases[0].database_id = '00000000-0000-4000-8000-000000000001';
  worker.r2_buckets[0].bucket_name = 'direct-ota-test';
  await writeFile(workerFile, JSON.stringify(worker));
  const commands = [];
  const deploy = (directory, options) => guidedDeploy(directory, options,
    (binary,args,settings) => commands.push({binary,args,settings}));
  const options = {provider:'cloudflare','account-id':'a'.repeat(32)};
  const original = await readFile(join(root,'capacitor.config.json'),'utf8');
  const plan = await finishSetup(root, {...options,plan:true}, {deploy});
  assert.equal(plan.applied,false);
  assert.match(plan.plan,/Cloudflare account a{32}/);
  const commandPlan=execFileSync(process.execPath,[join(source,'cli/index.mjs'),'setup','--finish','--provider','cloudflare',
    '--account-id','a'.repeat(32),'--plan','--project',root],{encoding:'utf8'});
  assert.match(commandPlan,/Direct OTA finish plan/);
  assert.equal(await readFile(join(root,'capacitor.config.json'),'utf8'),original);
  assert.equal(commands.length,0);
  await assert.rejects(finishSetup(root,{...options,apply:true},{deploy}),/--dedicated/);
  assert.equal(await readFile(join(root,'capacitor.config.json'),'utf8'),original);
  let synced = 0, checked = 0;
  const result = await finishSetup(root,{...options,apply:true,dedicated:true},{deploy,
    sync: async directory => {
      synced++;
      const source = JSON.parse(await readFile(join(directory,'capacitor.config.json'),'utf8'));
      await mkdir(join(directory,'ios/App/App'),{recursive:true});
      await writeFile(join(directory,'ios/App/App/capacitor.config.json'),JSON.stringify({plugins:source.plugins}));
    },
    conformance: async () => ({mode:'read-only',checks:['synthetic']}),
    remote: async () => { checked++; return {release:null}; },
  });
  assert.equal(result.applied,true);
  assert.equal(synced,1);
  assert.equal(checked,1);
  assert.equal(commands.length,5);
  const report = await diagnoseProject(root,await readConfig(root));
  assert.equal(report.ready,true,JSON.stringify(report.checks));
});

test('finish safely wires a simple TypeScript Capacitor config and preserves other plugins', async t => {
  const root = await host(t);
  await rm(join(root,'capacitor.config.json'));
  await symlink(join(source,'node_modules/typescript'),join(root,'node_modules/typescript'),'dir');
  await writeFile(join(root,'capacitor.config.ts'), `import type {CapacitorConfig} from '@capacitor/cli';\nconst config: CapacitorConfig = {appId:'app.example.setup', appName:'Setup Test', webDir:'public-web', plugins: {Keyboard: {resize:'none'}}};\nexport default config;\n`);
  await guidedSetup(root,{provider:'cloudflare',baseUrl:'https://direct-ota-test.example.workers.dev',yes:true});
  const workerFile = join(root,'ota-service/wrangler.jsonc');
  const worker = JSON.parse((await readFile(workerFile,'utf8')).replace(/^\s*\/\/.*$/gm,''));
  worker.name='direct-ota-test'; worker.d1_databases[0].database_id='00000000-0000-4000-8000-000000000001';
  worker.r2_buckets[0].bucket_name='direct-ota-test';
  await writeFile(workerFile,JSON.stringify(worker));
  const options={provider:'cloudflare','account-id':'a'.repeat(32),apply:true,dedicated:true};
  const deploy=(directory,opts)=>guidedDeploy(directory,opts,()=>{});
  await finishSetup(root,options,{deploy,
    sync:async directory=>{
      const {hostPlugin}=await import('../cli/native-settings.mjs');
      const actual=await hostPlugin(directory);
      await mkdir(join(directory,'ios/App/App'),{recursive:true});
      await writeFile(join(directory,'ios/App/App/capacitor.config.json'),JSON.stringify({plugins:{CapacitorUpdater:actual.plugin}}));
    },conformance:async()=>({mode:'read-only',checks:['synthetic']}),remote:async()=>({release:null})});
  const text=await readFile(join(root,'capacitor.config.ts'),'utf8');
  assert.match(text,/directOtaUpdaterConfig from '\.\/direct-ota\.capacitor\.json'/);
  assert.match(text,/Keyboard: \{resize:'none'\}/);
  assert.match(text,/CapacitorUpdater: directOtaUpdaterConfig/);
  assert.equal((await diagnoseProject(root,await readConfig(root))).ready,true);
});

test('finish refuses to replace another updater identity before provider deployment', async t => {
  const root=await host(t);
  await guidedSetup(root,{provider:'cloudflare',baseUrl:'https://direct-ota-test.example.workers.dev',yes:true});
  const original=JSON.parse(await readFile(join(root,'capacitor.config.json'),'utf8'));
  original.plugins={CapacitorUpdater:{autoUpdate:'on'}};
  await writeFile(join(root,'capacitor.config.json'),JSON.stringify(original));
  let deployments=0;
  await assert.rejects(finishSetup(root,{provider:'cloudflare','account-id':'a'.repeat(32),apply:true,dedicated:true},
    {deploy:async()=>{deployments++;return {plan:'test'};}}),/another integration/);
  assert.equal(deployments,0);
});

test('finish scopes Firebase deployment to the reviewed project and private bucket', async t => {
  const root=await host(t);
  await guidedSetup(root,{provider:'firebase',baseUrl:'https://demo-direct-ota.web.app',yes:true});
  const options={provider:'firebase',target:'demo-direct-ota',bucket:'demo-direct-ota.firebasestorage.app'};
  const commands=[];
  const deploy=(directory,opts)=>guidedDeploy(directory,opts,(binary,args)=>commands.push({binary,args}));
  const preview=await finishSetup(root,{...options,plan:true},{deploy});
  assert.match(preview.plan,/Firebase project demo-direct-ota/);
  assert.equal(commands.length,0);
  await finishSetup(root,{...options,apply:true,dedicated:true},{deploy,
    sync:async directory=>{
      const sourceConfig=JSON.parse(await readFile(join(directory,'capacitor.config.json'),'utf8'));
      await mkdir(join(directory,'ios/App/App'),{recursive:true});
      await writeFile(join(directory,'ios/App/App/capacitor.config.json'),JSON.stringify({plugins:sourceConfig.plugins}));
    },conformance:async()=>({mode:'read-only',checks:['synthetic']}),remote:async()=>({release:null})});
  assert.equal(commands.length,5);
  assert(commands.some(item=>item.args.includes('--project') && item.args.includes('demo-direct-ota')));
  assert(commands.some(item=>item.args.includes('functions:direct-ota:directOta,hosting,firestore:rules,storage')));
});
