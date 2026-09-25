import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, lstat, access, cp, symlink, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {guidedSetup} from '../cli/setup.mjs';
import {readConfig, readIdentity} from '../cli/config.mjs';
import {verifyCapacitorPlugins} from '../cli/native.mjs';

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

test('setup rejects mismatched app identity, wrong provider, and unsafe output before writing', async t => {
  const root = await host(t);
  await assert.rejects(guidedSetup(root, {provider:'supabase',appId:'app.other',baseUrl:origin,yes:true}), /differs/);
  await assert.rejects(guidedSetup(root, {provider:'supabase',baseUrl:origin,out:'../outside',yes:true}), /inside the app/);
  await assert.rejects(guidedSetup(root, {provider:'firebase',baseUrl:origin,yes:true}), /supports --provider supabase/);
  await assert.rejects(access(join(root, '.direct-ota')));
});
