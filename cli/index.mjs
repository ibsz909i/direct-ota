#!/usr/bin/env node
import {parseArgs} from 'node:util';
import {resolve, join, dirname} from 'node:path';
import {readFile, writeFile, mkdir, cp} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {readConfig, readIdentity, initProject} from './config.mjs';
import {command} from './transport.mjs';
import {selector, prepare, upload, promote, instruction} from './releases.mjs';

const help = `Direct OTA — signed updates on your infrastructure

direct-ota init --app-id app.example.demo --base-url https://updates.example.com [--provider node|supabase]
direct-ota export-provider --provider node|supabase --out ./ota-service
direct-ota native --channel internal|production
direct-ota patch
direct-ota doctor
direct-ota prepare --platform ios|android --version 1.0.1 [--channel internal] [--rollout 100] [--out DIR]
direct-ota upload --release DIR
direct-ota promote --release DIR
direct-ota status --platform ios|android [--channel internal]
direct-ota rollout --from DIR --platform ios|android --channel production --rollout 1|5|25|100
direct-ota rollback --from DIR --platform ios|android --channel production
direct-ota withdraw --platform ios|android --channel production

All commands accept --project DIR and --identity FILE. Build and test changed features before prepare.
native produces configuration for the first store build; frontend updates use prepare/upload/promote.
See docs/quickstart.md and AGENTS.md for setup and release rules.
`;
try {
  const {positionals, values} = parseArgs({allowPositionals: true, options: Object.fromEntries([
    'project','identity','app-id','base-url','provider','channel','platform','version','out','release','from','rollout'
  ].map(name => [name, {type: 'string'}]).concat([['help', {type:'boolean', short:'h'}]]))});
  const action = positionals[0];
  if (!action || values.help) { console.log(help); process.exit(0); }
  if (positionals.length !== 1) throw new Error('Unexpected positional arguments');
  const root = resolve(values.project || '.');
  if (action === 'init') {
    await initProject(root, {appId: values['app-id'], baseUrl: values['base-url'], provider: values.provider});
    console.log('Created public configuration and a private local publishing identity. Back up .direct-ota/identity.json securely; never commit it.');
  } else if (action === 'export-provider') {
    if (!['node','supabase'].includes(values.provider) || !values.out) throw new Error('Specify --provider node|supabase and --out DIR');
    const dest = resolve(root, values.out);
    await mkdir(dest, {recursive: false});
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    await cp(join(packageRoot, 'providers', values.provider), dest, {recursive: true, errorOnExist: true, force: false});
    if (values.provider === 'supabase') {
      await mkdir(join(dest, 'functions/_shared'), {recursive: true});
      await cp(join(packageRoot,'src/protocol.ts'), join(dest,'functions/_shared/protocol.ts'));
    }
    console.log('Provider files exported. Follow its README to deploy with your public trust configuration.');
  } else {
    const config = await readConfig(root);
    if (action === 'native' || action === 'patch' || action === 'doctor') {
      const native = await import('./native.mjs');
      if (action === 'patch') {
        await native.installNative(root, config);
        console.log('Pinned native overlay applied. Recorded runtime was not changed.');
      } else if (action === 'native') {
        await native.installNative(root, config);
        await native.writeNativeConfig(root, config, {channel: values.channel || 'internal'});
        console.log('Native integration prepared. Merge the generated plugin configuration, sync Capacitor, then build and verify each target platform.');
      } else {
        const {verifyNativeProject} = await import('./doctor.mjs');
        await verifyNativeProject(root, config);
        console.log('Native runtime and generated/synced plugin configuration match. This does not verify deployment or device installation.');
      }
    } else {
      const identity = await readIdentity(root, config, values.identity);
      if (action === 'status') console.log(JSON.stringify(await command(config, identity, 'status', await selector(root, values)), null, 2));
      else if (action === 'prepare') console.log(await prepare(root, config, identity, values));
      else if (action === 'upload' || action === 'promote') {
        if (!values.release) throw new Error('Specify --release DIR');
        const result = await (action === 'upload' ? upload : promote)(resolve(root, values.release), config, identity);
        console.log(result ? JSON.stringify(result) : 'Immutable artifact uploaded. It is not active until promoted.');
      } else if (['rollout', 'rollback', 'withdraw'].includes(action)) {
        console.log(JSON.stringify(await instruction(root, config, identity, values, action === 'withdraw' ? 'withdraw' : 'release')));
      } else throw new Error('Unknown command. Use --help.');
    }
  }
} catch (error) {
  // Never print response bodies, upload capabilities, private keys or stack traces.
  console.error('Direct OTA: ' + (error instanceof Error ? error.message : 'Operation failed'));
  process.exitCode = 1;
}
