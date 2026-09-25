import {join} from 'node:path';
import {lstat, readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {isDeepStrictEqual} from 'node:util';
import {readConfig, readIdentity} from './config.mjs';
import {guidedDeploy} from './deploy.mjs';
import {verifyCapacitorPlugins, verifyNativePatch, fingerprintNative, nativePluginConfig, writeNativeConfig} from './native.mjs';
import {hostPlugin, mergeJsonPlugin, mergeTypeScriptPlugin} from './native-settings.mjs';
import {verifyNativeProject} from './doctor.mjs';
import {verifyRemote} from './remote-doctor.mjs';
import {testProvider} from './conformance.mjs';

function syncNative(root) {
  const executable = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'cap.cmd' : 'cap');
  const result = spawnSync(executable, ['sync'], {cwd: root, stdio: ['ignore', 'ignore', 'inherit'], timeout: 180000});
  if (result.status !== 0) throw Error(`Capacitor sync failed (${result.signal || `exit ${result.status ?? 'unknown'}`})`);
}

async function platforms(root) {
  const result = [];
  for (const name of ['ios', 'android']) {
    try {
      const stat = await lstat(join(root, name));
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error(`${name} must be a real native platform directory`);
      result.push(name);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!result.length) throw Error('Add an iOS or Android platform before finishing setup');
  return result;
}

/** Complete an already prepared setup. Every remote target must be explicitly reviewed. */
export async function finishSetup(root, options = {}, dependencies = {}) {
  if (options.plan && options.apply) throw Error('Choose --plan or --apply');
  if (!['cloudflare', 'firebase'].includes(options.provider))
    throw Error('Automatic finish supports dedicated Cloudflare or Firebase services; follow the reviewed Supabase migration guide for a shared database');
  const config = await readConfig(root);
  const identity = await readIdentity(root, config, options.identity);
  verifyCapacitorPlugins(root);
  verifyNativePatch(root);
  const targets = await platforms(root);
  const runtimeFile = join(root, 'direct-ota.runtime.json');
  const recorded = JSON.parse(await readFile(runtimeFile, 'utf8'));
  if (recorded.protocol !== 1 || recorded.runtime !== fingerprintNative(root, config))
    throw Error('Native runtime drift detected; prepare a new native build before finishing setup');
  const generated = JSON.parse(await readFile(join(root, 'direct-ota.capacitor.json'), 'utf8'));
  const channel = options.channel || generated.directOtaChannel;
  const plugin = nativePluginConfig(config, recorded.runtime, channel);
  if (!isDeepStrictEqual(generated, plugin)) throw Error('Generated native settings differ from pinned trust; run doctor --fix first');
  const host = await hostPlugin(root);
  if (host.file === 'capacitor.config.js' && !isDeepStrictEqual(host.plugin, plugin))
    throw Error(`Merge direct-ota.capacitor.json into ${host.file}, then rerun setup --finish`);
  if (host.file === 'capacitor.config.ts' && !isDeepStrictEqual(host.plugin, plugin))
    await mergeTypeScriptPlugin(root, plugin, {dryRun:true});
  if (host.file === 'capacitor.config.json' && host.plugin && !isDeepStrictEqual(host.plugin, plugin) &&
      (host.plugin.directOtaAppId !== config.appId || host.plugin.directOtaKeyId !== (config.trustedKeys?.[0]?.keyId ?? config.keyId) ||
       host.plugin.directOtaArtifactBaseUrl !== config.artifactBaseUrl))
    throw Error('Existing CapacitorUpdater settings belong to another integration; review manually');

  const deploy = dependencies.deploy || guidedDeploy;
  const preview = await deploy(root, {...options, apply: false});
  const plan = [`Direct OTA finish plan for ${config.appId}`,
    `Native: ${targets.join(', ')}; ${host.file === 'capacitor.config.json' ? 'merge only plugins.CapacitorUpdater' : host.file === 'capacitor.config.ts' && !isDeepStrictEqual(host.plugin, plugin) ? 'insert a generated updater import and property in the simple TypeScript config' : 'use the already merged updater settings'}, run local Capacitor sync, and verify runtime/settings.`,
    `Provider: ${preview.plan}`,
    'After deployment: run read-only provider conformance and check each platform metadata endpoint. No update is published or production channel promoted.',
    'First native build, client coordinator wiring, and device acceptance remain app-specific checks.',
  ].join('\n');
  if (!options.apply) return {applied: false, plan};
  if (!options.dedicated) throw Error('Pass --dedicated after reviewing the exact update-only account and resources');

  if (host.file === 'capacitor.config.json') await mergeJsonPlugin(root, plugin, config);
  if (host.file === 'capacitor.config.ts' && !isDeepStrictEqual(host.plugin, plugin))
    await mergeTypeScriptPlugin(root, plugin);
  const sync = dependencies.sync || syncNative;
  // Sync can change native lockfiles. Converge on the final fingerprint before deployment.
  let stable = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    writeNativeConfig(root, config, {channel});
    const current = JSON.parse(await readFile(join(root, 'direct-ota.capacitor.json'), 'utf8'));
    if (host.file === 'capacitor.config.json') await mergeJsonPlugin(root, current, config);
    if (host.file === 'capacitor.config.ts' && !isDeepStrictEqual((await hostPlugin(root)).plugin, current))
      throw Error('Native inputs changed after TypeScript integration; update the imported runtime and rerun sync');
    await sync(root);
    if (fingerprintNative(root, config) === JSON.parse(await readFile(runtimeFile, 'utf8')).runtime) {
      await verifyNativeProject(root, config);
      stable = true;
      break;
    }
  }
  if (!stable) throw Error('Native inputs did not stabilize after three syncs; review changes before deployment');
  await deploy(root, {...options, apply: true, dedicated: true});
  const conformance = dependencies.conformance || testProvider;
  let admissionError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { await conformance(config, identity, {write:false}); admissionError = null; break; }
    catch (error) {
      admissionError = error;
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
  if (admissionError) throw Error(`Provider deployed but read-only conformance failed: ${admissionError.message}`);
  const remote = dependencies.remote || verifyRemote;
  for (const platform of targets) {
    let last;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await remote(root, config, {platform, channel}); last = null; break; }
      catch (error) { last = error; if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1))); }
    }
    if (last) throw Error(`Provider deployed but ${platform} metadata verification failed: ${last.message}`);
  }
  return {applied: true, plan, platforms: targets};
}
