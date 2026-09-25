import fs from 'node:fs';
import {writeFile, lstat, access} from 'node:fs/promises';
import {join, resolve, dirname} from 'node:path';
import {createRequire} from 'node:module';
import {randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createInterface} from 'node:readline/promises';
import {initProject, readConfig, readIdentity, httpsUrl} from './config.mjs';
import {verifyCapacitorPlugins, verifyNativePatch, installNative, writeNativeConfig} from './native.mjs';
import {exportProvider, configureSupabaseExport} from './provider.mjs';

const marker = 'DIRECT_OTA_HOST=';
const nativePlatforms = ['ios', 'android'];
const configNames = ['capacitor.config.ts', 'capacitor.config.js', 'capacitor.config.json'];

function inspectHost(root) {
  const packageFile = join(root, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  const declared = {...pkg.dependencies, ...pkg.devDependencies};
  if (!Object.hasOwn(declared, 'direct-ota')) throw new Error('Install the Direct OTA release tarball as a direct app dependency before setup');
  if (!Object.hasOwn(declared, '@capacitor/core')) throw new Error('Install Capacitor 8 in this app before setup');
  const hostRequire = createRequire(packageFile);
  let configPath, core;
  try {
    configPath = hostRequire.resolve('@capacitor/cli/dist/config.js');
    core = JSON.parse(fs.readFileSync(hostRequire.resolve('@capacitor/core/package.json'), 'utf8'));
  } catch { throw new Error('Install Capacitor CLI 8 and Core 8 in this app before setup'); }
  if (!/^8\./.test(core.version)) throw new Error('This setup supports Capacitor 8 only');
  verifyCapacitorPlugins(root);
  const configs = configNames.filter(name => fs.existsSync(join(root, name)));
  if (configs.length !== 1) throw new Error('Use exactly one capacitor.config.ts, .js, or .json file');
  if (!fs.lstatSync(join(root, configs[0])).isFile()) throw new Error('Capacitor config must be a regular file');
  const lock = join(root, 'package-lock.json');
  if (!fs.existsSync(lock) || !fs.lstatSync(lock).isFile()) throw new Error('This guided setup requires a regular npm package-lock.json');
  const script = `const {loadConfig}=require(process.argv[1]);loadConfig().then(c=>process.stdout.write('${marker}'+JSON.stringify({appId:c.app.appId,webDir:c.app.webDir})+'\\n')).catch(()=>process.exit(2));`;
  const result = spawnSync(process.execPath, ['-e', script, configPath], {
    cwd: root, encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) throw new Error('Capacitor config could not be loaded');
  const line = result.stdout?.split('\n').find(value => value.startsWith(marker));
  if (!line) throw new Error('Capacitor config did not return app settings');
  const host = JSON.parse(line.slice(marker.length));
  if (typeof host.appId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(host.appId)) throw new Error('Set a valid appId in capacitor.config');
  if (typeof host.webDir !== 'string' || !/^(?:\.\/)?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(host.webDir) || host.webDir.split('/').some(part => part === '..')) throw new Error('Set a relative webDir inside the app');
  const platforms = nativePlatforms.filter(name => {
    const location = join(root, name);
    if (!fs.existsSync(location)) return false;
    const stat = fs.lstatSync(location);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${name} must be a real native platform directory`);
    return true;
  });
  if (!platforms.length) throw new Error('Add at least one native platform with Capacitor before setup');
  return {appId: host.appId, webDir: host.webDir, platforms, configFile: configs[0]};
}

async function assertAvailable(root, output) {
  for (const name of ['direct-ota.config.json', 'direct-ota.runtime.json', 'direct-ota.capacitor.json', '.direct-ota', '.gitignore']) {
    let stat;
    try { stat = await lstat(join(root, name)); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.isSymbolicLink()) throw new Error(`${name} is a symlink; review it before setup`);
    if (name !== '.gitignore') throw new Error(`${name} already exists; use the manual commands to continue an existing setup`);
    if (!stat.isFile()) throw new Error('.gitignore must be a regular file');
    await access(join(root, name), fs.constants.W_OK);
  }
  try { await lstat(output); throw new Error('Provider output already exists; choose a new --out directory'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function planText({host, baseUrl, out, channel, provider}) {
  const cloudflare = provider === 'cloudflare';
  const firebase = provider === 'firebase';
  const label = cloudflare ? 'Cloudflare Worker' : firebase ? 'Firebase Hosting' : 'Supabase';
  return [
    'Direct OTA setup plan',
    `App: ${host.appId} (Capacitor 8; ${host.platforms.join(', ')})`,
    `Web directory: ${host.webDir}`,
    `${label} origin: ${baseUrl}`,
    `Local provider output: ${out}`,
    `Native channel: ${channel}`,
    `Local changes: create a private signing identity, public config, ignored ${cloudflare || firebase ? 'provider secret files' : 'trust env file'},`,
    'append .direct-ota/ to .gitignore,',
    `export a ${label} provider, patch the pinned updater, and generate native settings.`,
    `No migration, ${cloudflare ? 'Worker' : firebase ? 'Cloud Function' : 'Edge Function'}, bucket, or release is deployed by this command.`,
    `You must review the exported ${cloudflare ? 'D1 migration' : firebase ? 'Firestore and Storage rules' : 'SQL'}, deploy to the intended ${cloudflare ? 'Cloudflare account' : firebase ? 'Firebase project' : 'Supabase project'}, merge native`,
    'settings, sync/build the app, and verify an update on a device before publishing.',
  ].join('\n');
}

async function ask(question) {
  const rl = createInterface({input: process.stdin, output: process.stdout});
  try { return (await rl.question(question)).trim(); } finally { rl.close(); }
}

export async function guidedSetup(root, options = {}) {
  if (options.provider && !['supabase', 'cloudflare', 'firebase'].includes(options.provider)) throw new Error('Guided setup supports --provider supabase, cloudflare, or firebase only');
  const provider = options.provider || 'supabase';
  const host = inspectHost(root);
  verifyNativePatch(root);
  if (options.appId && options.appId !== host.appId) throw new Error('--app-id differs from capacitor.config');
  const channel = options.channel || 'internal';
  if (!['internal', 'production'].includes(channel)) throw new Error('Use --channel internal or production');
  const output = resolve(root, options.out || 'ota-service');
  if (dirname(output) !== root) throw new Error('Provider output must be a new directory directly inside the app project');
  await assertAvailable(root, output);
  let baseUrl = options.baseUrl;
  if (!baseUrl && process.stdin.isTTY) baseUrl = await ask(`${provider === 'cloudflare' ? 'Cloudflare Worker' : provider === 'firebase' ? 'dedicated Firebase Hosting' : 'Supabase project'} HTTPS origin: `);
  if (!baseUrl) throw new Error('Specify --base-url with the provider HTTPS origin');
  const url = httpsUrl(baseUrl + '/');
  if (baseUrl.endsWith('/') || url.pathname !== '/' || url.origin !== baseUrl) throw new Error('Use the exact provider HTTPS origin without a path or trailing slash');
  const plan = planText({host, baseUrl, out: output.slice(root.length + 1), channel, provider});
  if (options.plan) return {applied: false, plan};
  if (!options.yes) {
    if (!process.stdin.isTTY) throw new Error('Review with --plan, then use --yes for noninteractive local setup');
    console.log(plan);
    if ((await ask('Create these local files? Type yes to continue: ')) !== 'yes') return {applied: false, plan};
  }
  const config = await initProject(root, {appId: host.appId, baseUrl, provider,
    webDir: host.webDir, runtimeInputs: [host.configFile, 'package-lock.json', ...host.platforms]});
  await exportProvider(provider, output);
  if (provider === 'supabase') {
    await configureSupabaseExport(output, config);
    const env = join(root, '.direct-ota', 'supabase-trust.env');
    await writeFile(env, `OTA_TRUST_JSON=${JSON.stringify(config)}\n`, {flag: 'wx', mode: 0o600});
  } else {
    const env = join(root, '.direct-ota', `${provider}-trust.json`);
    await writeFile(env, JSON.stringify(config) + '\n', {flag: 'wx', mode: 0o600});
    await writeFile(join(root, '.direct-ota', `${provider}-upload-secret`),
      randomBytes(32).toString('base64'), {flag: 'wx', mode: 0o600});
  }
  installNative(root, config);
  writeNativeConfig(root, config, {channel});
  // Check that the freshly written public configuration still agrees with the private identity.
  await readIdentity(root, await readConfig(root));
  return {applied: true, plan, output, channel};
}
