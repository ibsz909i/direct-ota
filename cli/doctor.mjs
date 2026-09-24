import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {fingerprintNative, nativePluginConfig, verifyCapacitorPlugins} from './native.mjs';

export async function verifyNativeProject(root, config) {
  verifyCapacitorPlugins(root);
  const recorded = JSON.parse(await readFile(join(root, 'direct-ota.runtime.json'), 'utf8'));
  const runtime = fingerprintNative(root, config);
  if (recorded.protocol !== 1 || recorded.runtime !== runtime) throw new Error('Native runtime drift detected. Prepare and verify a new native build.');
  const generated = JSON.parse(await readFile(join(root, 'direct-ota.capacitor.json'), 'utf8'));
  const expected = nativePluginConfig(config, runtime, generated.directOtaChannel);
  if (!isDeepStrictEqual(generated, expected)) throw new Error('Generated native plugin configuration differs from the pinned trust/settings');
  let platforms = 0;
  for (const [platform, path] of [['ios', 'ios/App/App/capacitor.config.json'], ['android', 'android/app/src/main/assets/capacitor.config.json']]) {
    let native;
    try { native = JSON.parse(await readFile(join(root, path), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!isDeepStrictEqual(native.plugins?.CapacitorUpdater, expected)) throw new Error(`${platform} plugin configuration is stale or inconsistent. Merge generated settings and sync before building.`);
    platforms++;
  }
  if (!platforms) throw new Error('No synced native configuration found. Add a target platform and run Capacitor sync.');
  return {runtime, platforms};
}
