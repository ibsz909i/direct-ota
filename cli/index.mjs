#!/usr/bin/env node
import {parseArgs} from 'node:util';
import {resolve} from 'node:path';
import {readConfig, readIdentity, initProject} from './config.mjs';
import {exportProvider} from './provider.mjs';
import {command} from './transport.mjs';
import {selector, prepare, upload, promote, instruction} from './releases.mjs';

const help = `Direct OTA — signed updates on your infrastructure

direct-ota init --app-id app.example.demo --base-url https://updates.example.com [--provider node|supabase|cloudflare]
direct-ota setup --provider supabase|cloudflare --base-url https://YOUR_HOST [--channel internal] [--plan|--yes]
direct-ota export-provider --provider node|supabase|cloudflare --out ./ota-service
direct-ota native --channel internal|production
direct-ota patch
direct-ota doctor [--remote --platform ios|android] [--channel internal]
direct-ota publish --platform ios|android --version 1.0.1 [--out DIR]
direct-ota prepare --platform ios|android --version 1.0.1 [--channel internal] [--rollout 100] [--out DIR]
direct-ota upload --release DIR
direct-ota promote --release DIR
direct-ota status --platform ios|android [--channel internal]
direct-ota rollout --from DIR --platform ios|android --channel production --rollout 1|5|25|100
direct-ota rollback --from DIR --platform ios|android --channel production
direct-ota withdraw --platform ios|android --channel production

All commands accept --project DIR and --identity FILE. Test changed features before publish.
setup prepares local files only; it never deploys a provider or publishes an update.
native produces configuration for the first store build; frontend updates use prepare/upload/promote.
publish runs the host app build, then prepares, uploads, promotes, and verifies an internal release.
See docs/quickstart.md and AGENTS.md for setup and release rules.
`;
try {
  const {positionals, values} = parseArgs({allowPositionals: true, options: Object.fromEntries([
    'project','identity','app-id','base-url','provider','channel','platform','version','out','release','from','rollout'
  ].map(name => [name, {type: 'string'}]).concat([
    ['help', {type:'boolean', short:'h'}], ['plan', {type:'boolean'}], ['yes', {type:'boolean'}], ['remote', {type:'boolean'}]
  ]))});
  const action = positionals[0];
  if (!action || values.help) { console.log(help); process.exit(0); }
  if (positionals.length !== 1) throw new Error('Unexpected positional arguments');
  const root = resolve(values.project || '.');
  if (action === 'setup') {
    const {guidedSetup} = await import('./setup.mjs');
    const result = await guidedSetup(root, {
      provider: values.provider, appId: values['app-id'], baseUrl: values['base-url'],
      out: values.out, channel: values.channel, plan: values.plan, yes: values.yes,
    });
    if (values.plan || !result.applied) console.log(result.plan);
    else console.log([
      'Local setup prepared. No remote project was changed.',
      'Next:',
      ...(values.provider === 'cloudflare' ? [
        '1. Review ota-service/migrations and the intended Cloudflare account.',
        '2. Create an isolated D1 database and R2 bucket; set public trust and private upload secret; deploy the Worker.',
      ] : [
        '1. Review ota-service/migrations, ota-service/setup.sql, and the intended linked Supabase project.',
        '2. Apply the reviewed migration and setup SQL; set Edge trust from .direct-ota/supabase-trust.env; deploy both functions.',
      ]),
      '3. Merge direct-ota.capacitor.json into CapacitorUpdater settings, then run native again and npx cap sync.',
      '4. Wire the updater coordinator and readiness signal, build a native app, run npx direct-ota doctor, and test an internal OTA on a device.',
      `See docs/quickstart.md and docs/providers/${values.provider === 'cloudflare' ? 'cloudflare' : 'supabase'}.md for deployment steps.`,
    ].join('\n'));
  } else if (action === 'init') {
    await initProject(root, {appId: values['app-id'], baseUrl: values['base-url'], provider: values.provider});
    console.log('Created public configuration and a private local publishing identity. Back up .direct-ota/identity.json securely; never commit it.');
  } else if (action === 'export-provider') {
    if (!['node','supabase','cloudflare'].includes(values.provider) || !values.out) throw new Error('Specify --provider node|supabase|cloudflare and --out DIR');
    const dest = resolve(root, values.out);
    await exportProvider(values.provider, dest);
    console.log('Provider files exported. Follow its README to deploy with your public trust configuration.');
  } else {
    const config = await readConfig(root);
    if (action === 'native' || action === 'patch' || action === 'doctor') {
      const native = await import('./native.mjs');
      if (action === 'patch') {
        native.verifyCapacitorPlugins(root);
        await native.installNative(root, config);
        console.log('Pinned native overlay applied. Recorded runtime was not changed.');
      } else if (action === 'native') {
        native.verifyCapacitorPlugins(root);
        await native.installNative(root, config);
        await native.writeNativeConfig(root, config, {channel: values.channel || 'internal'});
        console.log('Native integration prepared. Merge the generated plugin configuration, sync Capacitor, then build and verify each target platform.');
      } else {
        const {verifyNativeProject} = await import('./doctor.mjs');
        await verifyNativeProject(root, config, values.remote ? values.platform : undefined);
        if (values.remote) {
          const {verifyRemote} = await import('./remote-doctor.mjs');
          console.log(JSON.stringify(await verifyRemote(root, config, values), null, 2));
        } else console.log('Native runtime and generated/synced plugin configuration match. This does not verify deployment or device installation.');
      }
    } else {
      const identity = await readIdentity(root, config, values.identity);
      if (action === 'status') console.log(JSON.stringify(await command(config, identity, 'status', await selector(root, values)), null, 2));
      else if (action === 'publish') {
        const {publish} = await import('./publish.mjs');
        console.log(JSON.stringify(await publish(root, config, identity, values), null, 2));
      }
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
