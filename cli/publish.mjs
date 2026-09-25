import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {command} from './transport.mjs';
import {prepare, upload, promote, readRelease, selector} from './releases.mjs';

async function build(root) {
  const host = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (typeof host.scripts?.build !== 'string' || !host.scripts.build.trim()) {
    throw new Error('The host app needs a package.json build script before publishing');
  }
  await new Promise((resolve, reject) => {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const child = spawn(npm, ['run', 'build'], {cwd: root, stdio: ['ignore', 'ignore', 'inherit']});
    child.on('error', reject);
    child.on('close', (code, signal) => code === 0 ? resolve() : reject(new Error(
      `Host build failed (${signal || `exit ${code}`}); no update was prepared or promoted`,
    )));
  });
}

/** Build and publish an internal candidate. Production is promoted separately after device verification. */
export async function publish(root, config, identity, options) {
  if (options.channel && options.channel !== 'internal') {
    throw new Error('publish targets the internal channel; use rollout for verified production releases');
  }
  if (!options.platform || !options.version) throw new Error('Specify --platform ios|android and --version SEMVER');
  if (options.release) throw new Error('To resume a prepared candidate, use upload --release DIR then promote --release DIR');
  await build(root);
  const directory = await prepare(root, config, identity, {...options, channel: 'internal'});
  try {
    await upload(directory, config, identity);
    const promoted = await promote(directory, config, identity);
    const {signed, manifest} = await readRelease(directory, config);
    const current = await command(config, identity, 'status', await selector(root, {...options, channel: 'internal'}));
    if (current.sequence !== manifest.sequence || current.manifest !== signed ||
        promoted.sequence !== manifest.sequence || promoted.releaseId !== manifest.releaseId) {
      throw new Error('Channel status did not confirm the promoted release');
    }
    return {platform: manifest.platform, channel: manifest.channel, version: manifest.version,
      sequence: manifest.sequence, releaseId: manifest.releaseId, release: directory};
  } catch (error) {
    throw new Error(`Release kept at ${directory}. Check status before retrying upload/promote: ${error.message}`);
  }
}
