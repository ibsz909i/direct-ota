import {readFile, lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {nativeSnapshot, changedNativeInputs, nativePluginConfig, verifyCapacitorPlugins, verifyNativePatch} from './native.mjs';
import {readIdentity} from './config.mjs';
import {hostPlugin, mergeJsonPlugin, repairGeneratedPlugin} from './native-settings.mjs';

export async function verifyNativeProject(root, config, targetPlatform) {
  verifyCapacitorPlugins(root);
  const recorded = JSON.parse(await readFile(join(root, 'direct-ota.runtime.json'), 'utf8'));
  const current = nativeSnapshot(root, config);
  const runtime = current.runtime;
  if (recorded.protocol !== 1 || recorded.runtime !== runtime) {
    const changed = changedNativeInputs(recorded, current);
    throw new Error(`Native runtime drift detected${changed.length ? `; changed inputs: ${changed.join(', ')}` : ''}. Prepare and verify a new native build.`);
  }
  const generated = JSON.parse(await readFile(join(root, 'direct-ota.capacitor.json'), 'utf8'));
  const expected = nativePluginConfig(config, runtime, generated.directOtaChannel);
  if (!isDeepStrictEqual(generated, expected)) throw new Error('Generated native plugin configuration differs from the pinned trust/settings');
  let platforms = 0, targetFound = false;
  for (const [platform, path] of [['ios', 'ios/App/App/capacitor.config.json'], ['android', 'android/app/src/main/assets/capacitor.config.json']]) {
    let native;
    try { native = JSON.parse(await readFile(join(root, path), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!isDeepStrictEqual(native.plugins?.CapacitorUpdater, expected)) throw new Error(`${platform} plugin configuration is stale or inconsistent. Merge generated settings and sync before building.`);
    if (platform === targetPlatform) targetFound = true;
    platforms++;
  }
  if (!platforms) throw new Error('No synced native configuration found. Add a target platform and run Capacitor sync.');
  if (targetPlatform && !targetFound) throw new Error(`No synced ${targetPlatform} native configuration found. Add and sync that platform before publishing.`);
  return {runtime, platforms};
}

/** An actionable local report. Fixes never alter trust, private keys, or a recorded native runtime. */
export async function diagnoseProject(root, config, options = {}, remoteCheck) {
  const checks = [];
  let remoteResult;
  const check = async (name, action) => {
    try {
      const result = await action();
      if (result && typeof result === 'object' && 'warning' in result) {
        checks.push({name, ok: false, warning: true, detail: result.warning});
        return result;
      }
      checks.push({name, ok: true, detail: result}); return result;
    }
    catch (error) { checks.push({name, ok: false, detail: error.message}); return null; }
  };
  await check('Publishing identity', async () => { await readIdentity(root, config, options.identity); return 'matches public trust'; });
  await check('Pinned plugins and native overlay', () => {
    verifyCapacitorPlugins(root);
    verifyNativePatch(root);
    return 'installed';
  });
  const recorded = await check('Native runtime', async () => {
    const file = join(root, 'direct-ota.runtime.json');
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Recorded runtime must be a regular file');
    const value = JSON.parse(await readFile(file, 'utf8'));
    if (value.protocol !== 1 || !/^[0-9a-f]{64}$/.test(value.runtime)) throw Error('Invalid recorded runtime');
    const current = nativeSnapshot(root, config);
    if (current.runtime !== value.runtime) {
      const changed = changedNativeInputs(value, current);
      throw Error(`Native inputs changed${changed.length ? `: ${changed.join(', ')}` : ''}; prepare and rebuild a new native binary`);
    }
    return value.runtime;
  });
  let expected = null;
  await check('Generated updater settings', async () => {
    if (!recorded) throw Error('Resolve native runtime first');
    const file = join(root, 'direct-ota.capacitor.json');
    let current = null;
    try {
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Generated settings must be a regular file');
      const raw = await readFile(file, 'utf8');
      try { current = JSON.parse(raw); }
      catch { if (!options.fix) throw Error('Generated settings are invalid JSON; run doctor --fix --channel internal|production'); }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const channel = options.channel || current?.directOtaChannel;
    if (!['internal', 'production'].includes(channel)) throw Error('Specify --channel internal|production to regenerate settings');
    expected = nativePluginConfig(config, recorded, channel);
    if (!isDeepStrictEqual(current, expected)) {
      if (!options.fix) throw Error('Settings differ from pinned trust; run doctor --fix');
      await repairGeneratedPlugin(root, expected);
      return 'repaired from pinned public trust';
    }
    return 'matches pinned public trust';
  });
  await check('Host Capacitor settings', async () => {
    if (!expected) throw Error('Resolve generated updater settings first');
    let host;
    try { host = await hostPlugin(root); }
    catch (error) {
      if (error.message === 'Use exactly one regular Capacitor config file')
        return {warning:'No source Capacitor config found; current native copies can still be checked, but review before the next sync'};
      throw error;
    }
    if (isDeepStrictEqual(host.plugin, expected)) return `${host.file} matches`;
    if (host.plugin && (host.plugin.directOtaAppId !== config.appId ||
        host.plugin.directOtaKeyId !== config.keyId ||
        host.plugin.directOtaArtifactBaseUrl !== config.artifactBaseUrl))
      throw Error('Source CapacitorUpdater belongs to another integration; review before syncing');
    if (!options.fix) return {warning:`${host.file} differs; run doctor --fix for JSON or merge settings manually before the next sync`};
    if (host.file !== 'capacitor.config.json') return {warning:`${host.file} requires a reviewed manual merge before the next sync`};
    await mergeJsonPlugin(root, expected, config);
    if (!isDeepStrictEqual((await hostPlugin(root)).plugin, expected)) throw Error('Host config did not load repaired updater settings');
    return `${host.file} repaired; sync native platforms`;
  });
  await check('Synced native platforms', async () => {
    const result = await verifyNativeProject(root, config, options.remote ? options.platform : undefined);
    return `${result.platforms} platform(s) match`;
  });
  if (options.remote) await check('Deployed update service', async () => {
    if (!options.platform) throw Error('Specify --platform ios|android for remote verification');
    if (checks.some(item => !item.ok && !item.warning)) throw Error('Resolve failed local checks before remote verification');
    remoteResult = await remoteCheck(root, config, options);
    return remoteResult.release ? `signed release ${remoteResult.release} and artifact verified` : 'metadata reachable; no active release';
  });
  return {appId: config.appId, ready: checks.every(item => item.ok || item.warning), checks, remoteResult};
}

export function formatDoctorReport(result) {
  return [`Direct OTA readiness — ${result.appId}`,
    ...result.checks.map(item => `${item.warning ? '!' : item.ok ? '✓' : '✗'} ${item.name}: ${item.detail}`),
    result.ready ? 'Native runtime and generated/synced plugin configuration match. Resolve any warnings before the next sync; verify the installed app on a device before production.' :
      'Action needed. Fix the failed checks, then run doctor again.'].join('\n');
}
