import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {initProject} from '../cli/config.mjs';
import {exportProvider} from '../cli/provider.mjs';
import {guidedDeploy} from '../cli/deploy.mjs';

async function fixture(t, provider, baseUrl) {
  const root = await mkdtemp(join(tmpdir(), 'direct-ota-deploy-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  const config = await initProject(root, {appId:'app.example.deploy',baseUrl,provider});
  await exportProvider(provider, join(root, 'ota-service'));
  await writeFile(join(root,'.direct-ota',`${provider}-trust.json`),JSON.stringify(config),{mode:0o600});
  await writeFile(join(root,'.direct-ota',`${provider}-upload-secret`),randomBytes(32).toString('base64'),{mode:0o600});
  return root;
}

test('Cloudflare deployment preflight is read-only and applies only to the selected account', async t => {
  const root = await fixture(t,'cloudflare','https://direct-ota-test.example.workers.dev');
  const path = join(root,'ota-service/wrangler.jsonc');
  const worker = JSON.parse((await readFile(path,'utf8')).replace(/^\s*\/\/.*$/gm,''));
  worker.name = 'direct-ota-test';
  worker.d1_databases[0].database_name = 'direct-ota-test';
  worker.d1_databases[0].database_id = '00000000-0000-4000-8000-000000000001';
  worker.r2_buckets[0].bucket_name = 'direct-ota-test';
  await writeFile(path,JSON.stringify(worker));
  const options = {provider:'cloudflare','account-id':'a'.repeat(32)};
  const commands = [];
  const run = (binary,args,opts) => commands.push({binary,args,opts});
  const preview = await guidedDeploy(root,options,run);
  assert.equal(preview.applied,false);
  assert.equal(commands.length,0);
  await assert.rejects(guidedDeploy(root,{...options,apply:true},run),/--dedicated/);
  await guidedDeploy(root,{...options,apply:true,dedicated:true},run);
  assert.equal(commands.length,5);
  assert(commands.every(({opts}) => opts.env.CLOUDFLARE_ACCOUNT_ID === 'a'.repeat(32)));
  assert(commands.every(({args}) => !args.some(value => value.includes('BEGIN PRIVATE KEY'))));
  assert(commands.some(({args}) => args.includes('migrations')));
  assert(commands.some(({args}) => args.includes('--strict')));
});

test('Firebase deployment preflight scopes to dedicated project, bucket and service', async t => {
  const root = await fixture(t,'firebase','https://demo-direct-ota.web.app');
  const options = {provider:'firebase',target:'demo-direct-ota',bucket:'demo-direct-ota.firebasestorage.app'};
  const commands = [];
  const run = (binary,args,opts) => commands.push({binary,args,opts});
  assert.equal((await guidedDeploy(root,options,run)).applied,false);
  assert.equal(commands.length,0);
  await assert.rejects(guidedDeploy(root,{...options,target:'other-project',apply:true,dedicated:true},run),/does not match/);
  await assert.rejects(guidedDeploy(root,{...options,apply:true},run),/--dedicated/);
  await guidedDeploy(root,{...options,apply:true,dedicated:true},run);
  assert.equal(commands.length,5);
  assert(commands.some(({args}) => args.includes('functions:direct-ota:directOta,hosting,firestore:rules,storage')));
  assert(commands.filter(({args}) => args.includes('functions:secrets:set')).every(({args}) => args.includes('--data-file')));
  assert.match(await readFile(join(root,'ota-service/functions/.env.demo-direct-ota'),'utf8'),/OTA_EVENTS_ENABLED=false/);
});
