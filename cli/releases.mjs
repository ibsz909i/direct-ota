import {readFile, mkdir, writeFile, mkdtemp, rm, readdir, lstat} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {randomUUID, createHash} from 'node:crypto';
import {verifyManifest, validateManifest, validateSelector, effectiveLimits} from '../dist/protocol.js';
import {signJws, encryptBundle} from './crypto.mjs';
import {command, validateUpload} from './transport.mjs';
import {writeJson} from './config.mjs';
import {signProvenance, verifyProvenance} from './provenance.mjs';

function sourceProvenance(root) {
  try {
    const commit = execFileSync('git', ['-C', root, 'rev-parse', '--verify', 'HEAD'], {encoding:'utf8',stdio:['ignore','pipe','ignore'],timeout:5000}).trim();
    if (!/^[0-9a-f]{40,64}$/.test(commit)) return null;
    const changes = execFileSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=normal'], {encoding:'utf8',stdio:['ignore','pipe','ignore'],timeout:5000,maxBuffer:1024*1024});
    return {commit, dirty: changes.length > 0};
  } catch { return null; }
}

export async function selector(root, options) {
  const {runtime} = JSON.parse(await readFile(join(root, 'direct-ota.runtime.json'), 'utf8'));
  return validateSelector({platform: options.platform, channel: options.channel || 'internal', runtime});
}
export async function prepare(root, config, identity, options) {
  if(options.mode!==undefined&&!['required','background'].includes(options.mode))throw new Error('Invalid update mode');
  const {verifyNativeProject} = await import('./doctor.mjs');
  const selected = await selector(root, options);
  await verifyNativeProject(root, config, selected.platform);
  const status = await command(config, identity, 'status', selected);
  if (!Number.isSafeInteger(status.sequence) || status.sequence < 0) throw new Error('Invalid channel sequence');
  const releaseId = randomUUID();
  const temp = await mkdtemp(join(tmpdir(), 'direct-ota-package-'));
  try {
    const zipPath = join(temp, 'web.zip');
    const scannerPath = join(temp, 'scanner.json');
    await writeFile(scannerPath, JSON.stringify({scanner:config.scanner ?? {},limits:effectiveLimits(config)}), {flag:'wx',mode:0o600});
    const result = execFileSync('python3', [fileURLToPath(new URL('./package.py', import.meta.url)), resolve(root, config.webDir), zipPath, scannerPath], {encoding: 'utf8', maxBuffer: 32768});
    const metadata = JSON.parse(result);
    const encrypted = encryptBundle(await readFile(zipPath), identity.bundle);
    if (encrypted.bytes.length > effectiveLimits(config).archiveBytes) throw new Error('Encrypted archive exceeds native-pinned limit');
    const path = `${selected.platform}/${selected.runtime}/${releaseId}/${encrypted.sha256}.zip`;
    const manifest = validateManifest({protocol: 1, appId: config.appId, environment: config.environment,
      ...selected, backendContract: config.backendContract, sequence: status.sequence + 1, action: 'release',
      rollout: Number(options.rollout ?? 100), releaseId, version: options.version, issuedAt: new Date().toISOString(),
      ...(options.mode===undefined?{}:{mode:options.mode}),
      artifact: {path, url: config.artifactBaseUrl + '/' + path, sha256: encrypted.sha256, bytes: encrypted.bytes.length,
        ...metadata, checksum: encrypted.checksum, sessionKey: encrypted.sessionKey}}, config);
    const directory = resolve(root, options.out || join('.direct-ota/releases', releaseId));
    await mkdir(directory, {recursive: false, mode: 0o700}).catch(async error => {
      if (error.code !== 'ENOENT') throw error;
      await mkdir(resolve(directory, '..'), {recursive: true, mode: 0o700});
      await mkdir(directory, {mode: 0o700});
    });
    const signed = signJws(manifest, identity.signing, config.keyId);
    await writeFile(join(directory, 'bundle.zip'), encrypted.bytes, {flag: 'wx'});
    await writeFile(join(directory, 'manifest.jws'), signed, {flag: 'wx'});
    await writeFile(join(directory, 'provenance.jws'), signProvenance(signed,manifest,sourceProvenance(root),identity,config), {flag:'wx'});
    await writeJson(join(directory, 'release.json'), {manifest, expectedSequence: status.sequence, artifactId: releaseId});
    return directory;
  } finally { await rm(temp, {recursive: true, force: true}); }
}
export async function readRelease(directory, config) {
  const file = join(directory, 'manifest.jws');
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Signed manifest must be a regular file');
  const signed = await readFile(file, 'utf8');
  return {signed, manifest: await verifyManifest(signed, config)};
}

export async function inspectRelease(directory, config) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Release must be a regular directory');
  const {signed, manifest} = await readRelease(directory, config);
  const metadata = join(directory, 'release.json');
  const metadataInfo = await lstat(metadata);
  if (!metadataInfo.isFile() || metadataInfo.isSymbolicLink() || metadataInfo.size > 16384) throw new Error('Local release metadata must be a bounded regular file');
  const record = JSON.parse(await readFile(metadata, 'utf8'));
  if (record.manifest?.releaseId !== manifest.releaseId || record.manifest?.artifact?.sha256 !== manifest.artifact?.sha256)
    throw new Error('Local release metadata does not match its signed manifest');
  const artifact = manifest.action === 'release' ? manifest.artifact : null;
  let provenance=null;
  const provenanceFile=join(directory,'provenance.jws');
  try {
    const stat=await lstat(provenanceFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size>4096) throw Error('Invalid release provenance file');
    provenance=verifyProvenance(await readFile(provenanceFile,'utf8'),signed,manifest,config);
  } catch(error) { if (error.code!=='ENOENT') throw error; }
  return {releaseId: manifest.releaseId, sequence: manifest.sequence, version: manifest.version,
    platform: manifest.platform, channel: manifest.channel, runtime: manifest.runtime, issuedAt: manifest.issuedAt,
    action: manifest.action, mode:manifest.action==='release'?manifest.mode??'required':null, rollout: manifest.rollout,
    artifact: artifact ? {id: artifact.path.split('/')[2], sha256: artifact.sha256, bytes: artifact.bytes} : null,
    source: provenance?.source ?? null, provenanceVerified: provenance!==null};
}

/** Local candidate history; a provider's live status remains authoritative. */
export async function localHistory(root, config, {platform, limit = 20, cursor} = {}) {
  if (platform !== undefined && !['ios','android'].includes(platform)) throw new Error('History platform must be ios or android');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('History limit must be 1–100');
  if (cursor !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(cursor)) throw new Error('Invalid history cursor');
  const base = join(root, '.direct-ota', 'releases');
  let entries;
  try { entries = await readdir(base, {withFileTypes:true}); }
  catch(error) { if (error.code === 'ENOENT') return {items:[], nextCursor:null, scope:'local'}; throw error; }
  if (entries.length > 10000) throw new Error('Local release directory exceeds history limit');
  const items=[];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const item = await inspectRelease(join(base, entry.name), config);
    if (platform === undefined || item.platform === platform) items.push(item);
  }
  items.sort((a,b)=>b.issuedAt.localeCompare(a.issuedAt)||b.releaseId.localeCompare(a.releaseId));
  const start = cursor === undefined ? 0 : items.findIndex(item=>item.releaseId===cursor)+1;
  if (cursor !== undefined && start === 0) throw new Error('History cursor does not exist');
  const page=items.slice(start,start+limit);
  return {items:page,nextCursor:start+limit<items.length?page.at(-1).releaseId:null,scope:'local'};
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
export async function instruction(root, config, identity, options, kind) {
  if(!['rollout','rollback','withdraw'].includes(kind))throw new Error('Invalid release instruction');
  if(options.mode!==undefined)throw new Error('Release instructions inherit mode; rollback is always required');
  const action=kind==='withdraw'?'withdraw':'release';
  const selected = await selector(root, options);
  const status = await command(config, identity, 'status', selected);
  if (!Number.isSafeInteger(status.sequence) || status.sequence < 0) throw new Error('Invalid channel sequence');
  let gatedHead;
  if (options['health-gate']) {
    if(action!=='release'||selected.channel!=='production'||!status.manifest)
      throw new Error('A health gate requires an existing production release');
    const current=await verifyManifest(status.manifest,config,selected);
    if(current.sequence!==status.sequence||current.action!=='release')throw new Error('Invalid channel head');
    gatedHead=current;
    const health=await command(config,identity,'health',{releaseId:current.releaseId});
    const {assertRolloutHealth}=await import('./health-gate.mjs');
    assertRolloutHealth(health,current.releaseId,{
      minReady:options['gate-min-ready']===undefined?10:Number(options['gate-min-ready']),
      maxFailures:options['gate-max-failures']===undefined?0:Number(options['gate-max-failures'])});
  } else if (options['gate-min-ready']!==undefined||options['gate-max-failures']!==undefined) {
    throw new Error('Health thresholds require --health-gate');
  }
  let previous;
  if (action === 'release') {
    if (!options.from) throw new Error('--from must point to an existing release directory');
    previous = (await readRelease(resolve(root, options.from), config)).manifest;
    if (previous.action !== 'release' || previous.platform !== selected.platform || previous.runtime !== selected.runtime) throw new Error('Artifact is not compatible with this platform/runtime');
    if(gatedHead){
      if(gatedHead.artifact.sha256!==previous.artifact.sha256||gatedHead.artifact.path!==previous.artifact.path)
        throw new Error('Health gate applies only to the same staged artifact');
      const stages=[1,5,25,100],prior=stages.indexOf(gatedHead.rollout);
      if(prior<0||stages[prior+1]!==Number(options.rollout))throw new Error('Health-gated rollout must advance one stage');
    }
  }
  const manifest = validateManifest({protocol: 1, appId: config.appId, environment: config.environment,
    ...selected, backendContract: config.backendContract, sequence: status.sequence + 1,
    action, rollout: Number(options.rollout ?? 100), releaseId: randomUUID(),
    version: previous?.version || options.version || '0.0.0', issuedAt: new Date().toISOString(),
    ...(kind==='rollout'&&previous?.mode?{mode:previous.mode}:{}),
    ...(previous ? {artifact: previous.artifact} : {})}, config);
  const signed = signJws(manifest, identity.signing, config.keyId);
  if (action === 'release') await command(config, identity, 'reserve', {manifest: signed});
  return command(config, identity, 'promote', {manifest: signed, expectedSequence: status.sequence});
}
