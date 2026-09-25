#!/usr/bin/env node
import {parseArgs} from 'node:util';
import {resolve} from 'node:path';
import {readConfig, readIdentity, initProject} from './config.mjs';
import {exportProvider} from './provider.mjs';
import {command} from './transport.mjs';
import {selector, prepare, upload, promote, instruction, inspectRelease, localHistory} from './releases.mjs';

const help = `Direct OTA — signed updates on your infrastructure

direct-ota init --app-id app.example.demo --base-url https://updates.example.com [--provider node|supabase|cloudflare|firebase]
direct-ota setup --provider supabase|cloudflare|firebase --base-url https://YOUR_HOST [--channel internal] [--plan|--yes]
direct-ota setup --finish --provider cloudflare|firebase --account-id ID|--target ID --bucket NAME [--plan|--apply --dedicated]
direct-ota deploy --provider cloudflare --account-id ID [--plan|--apply --dedicated]
direct-ota deploy --provider firebase --target PROJECT_ID --bucket BUCKET [--plan|--apply --dedicated]
direct-ota export-provider --provider node|supabase|cloudflare|firebase --out ./ota-service
direct-ota create-provider --name my-backend --out ./ota-provider
direct-ota native --channel internal|production
direct-ota key-stage  (pin a next signer, then ship a native store build)
direct-ota key-activate  (switch publisher after that native build is verified)
direct-ota patch
direct-ota doctor [--fix] [--remote --platform ios|android] [--channel internal]
direct-ota test-provider [--write]  (write mode uses a synthetic runtime; use an isolated service)
direct-ota publish --platform ios|android --version 1.0.1 [--mode required|background] [--out DIR]
direct-ota prepare --platform ios|android --version 1.0.1 [--channel internal] [--rollout 100] [--mode required|background] [--out DIR]
direct-ota upload --release DIR
direct-ota promote --release DIR
direct-ota status --platform ios|android [--channel internal]
direct-ota health --release-id UUID  (signed, opt-in aggregate reports)
direct-ota history [--platform ios|android] [--limit 20] [--cursor UUID]  (local signed candidates)
direct-ota history --remote --platform ios|android [--channel internal] [--limit 20] [--cursor SEQUENCE]
direct-ota inspect --release DIR  (local signed candidate)
direct-ota inspect --remote --release-id UUID  (promoted remote release)
direct-ota rollout --from DIR --platform ios|android --channel production --rollout 1|5|25|100 [--health-gate --gate-min-ready 10 --gate-max-failures 0]
direct-ota rollback --from DIR --platform ios|android --channel production
direct-ota withdraw --platform ios|android --channel production

All commands accept --project DIR and --identity FILE. Test changed features before publish.
setup prepares local files only. setup --finish reviews dedicated deployment, syncs native settings, and verifies the service.
native produces configuration for the first store build; frontend updates use prepare/upload/promote.
publish runs the host app build, then prepares, uploads, promotes, and verifies an internal release.
See docs/quickstart.md and AGENTS.md for setup and release rules.
`;
try {
  const {positionals, values} = parseArgs({allowPositionals: true, options: Object.fromEntries([
    'project','identity','app-id','base-url','provider','channel','platform','version','out','release','from','rollout','release-id','name','account-id','target','bucket','limit','cursor','gate-min-ready','gate-max-failures','mode'
  ].map(name => [name, {type: 'string'}]).concat([
    ['help', {type:'boolean', short:'h'}], ['plan', {type:'boolean'}], ['yes', {type:'boolean'}], ['remote', {type:'boolean'}], ['write', {type:'boolean'}], ['apply', {type:'boolean'}], ['dedicated', {type:'boolean'}], ['fix', {type:'boolean'}], ['finish', {type:'boolean'}], ['health-gate', {type:'boolean'}]
  ]))});
  const action = positionals[0];
  if (!action || values.help) { console.log(help); process.exit(0); }
  if (positionals.length !== 1) throw new Error('Unexpected positional arguments');
  const root = resolve(values.project || '.');
  if (action === 'create-provider') {
    if (!values.name || !values.out) throw new Error('Specify --name and --out');
    const {createProviderScaffold} = await import('./scaffold.mjs');
    await createProviderScaffold(resolve(root, values.out), values.name);
    console.log('Provider scaffold created. Implement the adapter and pass conformance before deployment.');
  } else if (action === 'deploy') {
    if (values.plan && values.apply) throw new Error('Choose --plan or --apply');
    const {guidedDeploy} = await import('./deploy.mjs');
    const result = await guidedDeploy(root, values);
    console.log(result.plan);
    if (result.applied) console.log('Provider deployment commands completed. Run test-provider, doctor --remote, and a device update before production use.');
  } else if (action === 'setup') {
    if (values.finish) {
      const {finishSetup} = await import('./finish-setup.mjs');
      const result = await finishSetup(root, values);
      console.log(result.plan);
      if (result.applied) console.log('Native settings and dedicated provider verified. Build and test the first native release on each target device.');
      process.exit(0);
    }
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
      ] : values.provider === 'firebase' ? [
        '1. Review the dedicated Firebase project, Firestore and Storage rules, and Hosting rewrites.',
        '2. Configure a private OTA bucket and Function secrets, then deploy the isolated provider.',
      ] : [
        '1. Review ota-service/migrations, ota-service/setup.sql, and the intended linked Supabase project.',
        '2. Apply the reviewed migration and setup SQL; set Edge trust from .direct-ota/supabase-trust.env; deploy both functions.',
      ]),
      '3. Merge direct-ota.capacitor.json into CapacitorUpdater settings, then run native again and npx cap sync.',
      '4. Wire the updater coordinator and readiness signal, build a native app, run npx direct-ota doctor, and test an internal OTA on a device.',
      `See docs/quickstart.md and docs/providers/${values.provider}.md for deployment steps.`,
    ].join('\n'));
  } else if (action === 'init') {
    await initProject(root, {appId: values['app-id'], baseUrl: values['base-url'], provider: values.provider});
    console.log('Created public configuration and a private local publishing identity. Back up .direct-ota/identity.json securely; never commit it.');
  } else if (action === 'export-provider') {
    if (!['node','supabase','cloudflare','firebase'].includes(values.provider) || !values.out) throw new Error('Specify --provider node|supabase|cloudflare|firebase and --out DIR');
    const dest = resolve(root, values.out);
    await exportProvider(values.provider, dest);
    console.log('Provider files exported. Follow its README to deploy with your public trust configuration.');
  } else {
    const config = await readConfig(root);
    if (action === 'key-stage' || action === 'key-activate') {
      const keys=await import('./keys.mjs');
      const result=action==='key-stage' ? await keys.stageSigningKey(root,config) : await keys.activateSigningKey(root,config);
      console.log(action==='key-stage'
        ? `Staged ${result.keyId}. Sync, rebuild, and verify a store app with the pinned key ring before activation. Private identity: ${result.identityFile}`
        : `Activated ${result.keyId} locally. Update the provider's active public trust and verify a signed internal release before production promotion.`);
    } else if (action === 'native' || action === 'patch' || action === 'doctor') {
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
        const {diagnoseProject, formatDoctorReport} = await import('./doctor.mjs');
        const remote = values.remote ? (await import('./remote-doctor.mjs')).verifyRemote : undefined;
        const report = await diagnoseProject(root, config, values, remote);
        if (report.ready && values.remote) console.log(JSON.stringify({...report.remoteResult, readiness: report.checks}, null, 2));
        else if (report.ready) console.log(formatDoctorReport(report));
        else { console.error(formatDoctorReport(report)); process.exitCode = 1; }
      }
    } else {
      const identity = ['history','inspect'].includes(action) && !values.remote ? null : await readIdentity(root, config, values.identity);
      if (action === 'status') console.log(JSON.stringify(await command(config, identity, 'status', await selector(root, values)), null, 2));
      else if (action === 'history') console.log(JSON.stringify(values.remote ?
        await command(config, identity, 'history', {...await selector(root, values),
          limit: values.limit === undefined ? 20 : Number(values.limit),
          ...(values.cursor === undefined ? {} : {beforeSequence:Number(values.cursor)})}) :
        await localHistory(root, config, {platform: values.platform,
          limit: values.limit === undefined ? 20 : Number(values.limit), cursor: values.cursor}), null, 2));
      else if (action === 'inspect') {
        if (values.remote) {
          if (!values['release-id'] || values.release) throw new Error('Specify --release-id UUID for remote inspect');
          console.log(JSON.stringify(await command(config, identity, 'inspect', {releaseId:values['release-id']}), null, 2));
        } else {
          if (!values.release || values['release-id']) throw new Error('Specify --release DIR for local inspect');
          console.log(JSON.stringify(await inspectRelease(resolve(root, values.release), config), null, 2));
        }
      }
      else if (action === 'health') {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(values['release-id'] || ''))
          throw new Error('Specify --release-id UUID');
        console.log(JSON.stringify(await command(config, identity, 'health', {releaseId: values['release-id']}), null, 2));
      }
      else if (action === 'test-provider') {
        const {testProvider} = await import('./conformance.mjs');
        console.log(JSON.stringify(await testProvider(config, identity, {write: values.write}), null, 2));
      }
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
        console.log(JSON.stringify(await instruction(root, config, identity, values, action)));
      } else throw new Error('Unknown command. Use --help.');
    }
  }
} catch (error) {
  // Never print response bodies, upload capabilities, private keys or stack traces.
  console.error('Direct OTA: ' + (error instanceof Error ? error.message : 'Operation failed'));
  process.exitCode = 1;
}
