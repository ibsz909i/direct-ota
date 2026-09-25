import {readFile, mkdir, writeFile, mkdtemp, rm} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {randomUUID, createHash} from 'node:crypto';
import {verifyManifest, validateManifest, validateSelector, OTA_MAX_ARCHIVE_BYTES} from '../dist/protocol.js';
import {signJws, encryptBundle} from './crypto.mjs';
import {command, validateUpload} from './transport.mjs';
import {writeJson} from './config.mjs';

export async function selector(root, options) {
  const {runtime} = JSON.parse(await readFile(join(root, 'direct-ota.runtime.json'), 'utf8'));
  return validateSelector({platform: options.platform, channel: options.channel || 'internal', runtime});
}
export async function prepare(root, config, identity, options) {
  const {verifyNativeProject} = await import('./doctor.mjs');
  const selected = await selector(root, options);
  await verifyNativeProject(root, config, selected.platform);
  const status = await command(config, identity, 'status', selected);
  if (!Number.isSafeInteger(status.sequence) || status.sequence < 0) throw new Error('Invalid channel sequence');
  const releaseId = randomUUID();
  const temp = await mkdtemp(join(tmpdir(), 'direct-ota-package-'));
  try {
    const zipPath = join(temp, 'web.zip');
    const result = execFileSync('python3', [fileURLToPath(new URL('./package.py', import.meta.url)), resolve(root, config.webDir), zipPath], {encoding: 'utf8', maxBuffer: 32768});
    const metadata = JSON.parse(result);
    const encrypted = encryptBundle(await readFile(zipPath), identity.bundle);
    if (encrypted.bytes.length > OTA_MAX_ARCHIVE_BYTES) throw new Error('Encrypted archive exceeds 5 MiB');
    const path = `${selected.platform}/${selected.runtime}/${releaseId}/${encrypted.sha256}.zip`;
    const manifest = validateManifest({protocol: 1, appId: config.appId, environment: config.environment,
      ...selected, backendContract: config.backendContract, sequence: status.sequence + 1, action: 'release',
      rollout: Number(options.rollout ?? 100), releaseId, version: options.version, issuedAt: new Date().toISOString(),
      artifact: {path, url: config.artifactBaseUrl + '/' + path, sha256: encrypted.sha256, bytes: encrypted.bytes.length,
        ...metadata, checksum: encrypted.checksum, sessionKey: encrypted.sessionKey}}, config);
    const directory = resolve(root, options.out || join('.direct-ota/releases', releaseId));
    await mkdir(directory, {recursive: false, mode: 0o700}).catch(async error => {
      if (error.code !== 'ENOENT') throw error;
      await mkdir(resolve(directory, '..'), {recursive: true, mode: 0o700});
      await mkdir(directory, {mode: 0o700});
    });
    await writeFile(join(directory, 'bundle.zip'), encrypted.bytes, {flag: 'wx'});
    await writeFile(join(directory, 'manifest.jws'), signJws(manifest, identity.signing, config.keyId), {flag: 'wx'});
    await writeJson(join(directory, 'release.json'), {manifest, expectedSequence: status.sequence});
    return directory;
  } finally { await rm(temp, {recursive: true, force: true}); }
}
export async function readRelease(directory, config) {
  const signed = await readFile(join(directory, 'manifest.jws'), 'utf8');
  return {signed, manifest: await verifyManifest(signed, config)};
}
export async function upload(directory, config, identity) {
  const {signed, manifest} = await readRelease(directory, config);
  if (manifest.action !== 'release') throw new Error('No artifact in this instruction');
  const data = await readFile(join(directory, 'bundle.zip'));
  if (data.length !== manifest.artifact.bytes || createHash('sha256').update(data).digest('hex') !== manifest.artifact.sha256) throw new Error('Artifact changed after signing');
  // Reserve again on retry: upload capabilities can expire and are never persisted in release files.
  for (let attempt = 0; attempt < 3; attempt++) {
    const reserved = await command(config, identity, 'reserve', {manifest: signed});
    if (reserved.uploadRequired === false) return;
    const {url, headers} = validateUpload(config, reserved.upload);
    try {
      const response = await fetch(url, {method: 'PUT', redirect: 'error', headers: {'Content-Type': 'application/zip', ...headers}, body: data, signal: AbortSignal.timeout(120000)});
      await response.body?.cancel();
      if (!response.ok) { const error = new Error(`Upload returned HTTP ${response.status}`); error.retryable = response.status >= 500 || [408, 409, 429].includes(response.status); throw error; }
      return;
    } catch (error) {
      if (attempt === 2 || error.retryable === false) throw error;
      await new Promise(r => setTimeout(r, 750 * (2 ** attempt) + Math.random() * 250));
    }
  }
}
export async function promote(directory, config, identity) {
  const {signed, manifest} = await readRelease(directory, config);
  return command(config, identity, 'promote', {manifest: signed, expectedSequence: manifest.sequence - 1});
}
export async function instruction(root, config, identity, options, action) {
  const selected = await selector(root, options);
  const status = await command(config, identity, 'status', selected);
  if (!Number.isSafeInteger(status.sequence) || status.sequence < 0) throw new Error('Invalid channel sequence');
  let previous;
  if (action === 'release') {
    if (!options.from) throw new Error('--from must point to an existing release directory');
    previous = (await readRelease(resolve(root, options.from), config)).manifest;
    if (previous.action !== 'release' || previous.platform !== selected.platform || previous.runtime !== selected.runtime) throw new Error('Artifact is not compatible with this platform/runtime');
  }
  const manifest = validateManifest({protocol: 1, appId: config.appId, environment: config.environment,
    ...selected, backendContract: config.backendContract, sequence: status.sequence + 1,
    action, rollout: Number(options.rollout ?? 100), releaseId: randomUUID(),
    version: previous?.version || options.version || '0.0.0', issuedAt: new Date().toISOString(),
    ...(previous ? {artifact: previous.artifact} : {})}, config);
  const signed = signJws(manifest, identity.signing, config.keyId);
  if (action === 'release') await command(config, identity, 'reserve', {manifest: signed});
  return command(config, identity, 'promote', {manifest: signed, expectedSequence: status.sequence});
}
