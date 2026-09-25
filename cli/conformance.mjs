import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {encryptBundle, signJws} from './crypto.mjs';
import {boundedJson, validateUpload} from './transport.mjs';
import {validateManifest, verifyManifest} from '../dist/protocol.js';

const html = '<main>Direct OTA provider conformance</main>';
const zipScript = `import io,sys,zipfile
out=io.BytesIO()
with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z: z.writestr('index.html',${JSON.stringify(html)})
sys.stdout.buffer.write(out.getvalue())`;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function jsonResponse(response) {
  if (!response.ok) { await response.body?.cancel(); throw Error(`Provider returned HTTP ${response.status}`); }
  return boundedJson(response);
}

/** Read-only probes are safe on an existing service; write tests need an isolated provider. */
export async function testProvider(config, identity, {write = false, fetcher = fetch} = {}) {
  const checks = [];
  const request = (url, init) => fetcher(url, {...init, redirect: 'error', signal: AbortSignal.timeout(30000)});
  const selector = {platform: 'ios', channel: 'internal', runtime: digest(randomBytes(32))};
  const checked = await jsonResponse(await request(config.checkUrl, {method: 'POST',
    headers: {'Content-Type': 'application/json'}, body: JSON.stringify(selector)}));
  if (checked?.manifest !== null) throw Error('Synthetic runtime unexpectedly has an update');
  checks.push('unknown runtime has no release');
  const unsigned = await request(config.publishUrl, {method: 'POST',
    headers: {'Content-Type': 'application/json'}, body: JSON.stringify({command: 'unsigned'})});
  if (![400, 401, 403].includes(unsigned.status)) throw Error('Unsigned publisher was accepted');
  await unsigned.body?.cancel(); checks.push('unsigned publish rejected');
  const oversized = await request(config.checkUrl, {method: 'POST',
    headers: {'Content-Type': 'application/json'}, body: JSON.stringify({...selector, padding: 'x'.repeat(1024)})});
  if (oversized.status !== 413) throw Error('Oversized metadata was accepted');
  await oversized.body?.cancel(); checks.push('bounded metadata');
  if (!write) return {mode: 'read-only', checks};

  const signCommand = (action, body, nonce = randomUUID()) => {
    const iat = Math.floor(Date.now() / 1000);
    return signJws({protocol: 1, appId: config.appId, aud: 'direct-ota-publish',
      action, iat, exp: iat + 60, nonce, body}, identity.signing, config.keyId, 'DIRECT-OTA-PUBLISH');
  };
  const publish = signed => request(config.publishUrl, {method: 'POST',
    headers: {'Content-Type': 'application/json'}, body: JSON.stringify({command: signed})});
  const command = async (action, body) => jsonResponse(await publish(signCommand(action, body)));
  const status = async () => command('status', selector);
  const first = await status();
  if (first.sequence !== 0 || first.manifest !== null) throw Error('Synthetic channel was not empty');
  checks.push('isolated empty channel');
  const zip = execFileSync('python3', ['-c', zipScript], {maxBuffer: 1024 * 1024});
  const encrypted = encryptBundle(zip, identity.bundle);
  const releaseId = randomUUID();
  const artifact = {path: `ios/${selector.runtime}/${releaseId}/${encrypted.sha256}.zip`,
    url: `${config.artifactBaseUrl}/ios/${selector.runtime}/${releaseId}/${encrypted.sha256}.zip`,
    sha256: encrypted.sha256, bytes: encrypted.bytes.length, unpackedBytes: Buffer.byteLength(html), files: 1,
    checksum: encrypted.checksum, sessionKey: encrypted.sessionKey};
  const base = {protocol: 1, appId: config.appId, environment: config.environment,
    ...selector, backendContract: config.backendContract, rollout: 100, version: '0.0.1'};
  const manifest = (action, sequence, id, content = artifact) => validateManifest({...base,
    action, sequence, releaseId: id, issuedAt: new Date().toISOString(),
    ...(action === 'release' ? {artifact: content} : {})}, config);
  const signed = signJws(manifest('release', 1, releaseId), identity.signing, config.keyId);
  let sequence = 0;
  try {
    const malformed = signCommand('reserve', {manifest: signed});
    const tampered = malformed.slice(0, -16) + (malformed.at(-16) === 'A' ? 'B' : 'A') + malformed.slice(-15);
    const bad = await publish(tampered);
    if (![401, 403].includes(bad.status)) throw Error('Altered publisher signature was accepted');
    await bad.body?.cancel(); checks.push('altered command rejected');

    const replayed = signCommand('status', selector);
    await jsonResponse(await publish(replayed));
    const replay = await publish(replayed);
    if (replay.status !== 409) throw Error('Publisher command replay was accepted');
    await replay.body?.cancel(); checks.push('publisher replay rejected');

    const reservation = await command('reserve', {manifest: signed});
    if (!reservation.uploadRequired || !reservation.upload) throw Error('New artifact was not reserved');
    const {url, headers} = validateUpload(config, reservation.upload);
    const altered = Buffer.from(encrypted.bytes); altered[0] ^= 1;
    const invalidUpload = await request(url, {method: 'PUT', headers, body: altered});
    if (invalidUpload.ok) throw Error('Altered artifact was accepted');
    await invalidUpload.body?.cancel(); checks.push('altered artifact rejected');
    await jsonResponse(await request(url, {method: 'PUT', headers, body: encrypted.bytes}));
    const duplicate = await request(url, {method: 'PUT', headers, body: encrypted.bytes});
    if (duplicate.ok) throw Error('Immutable artifact was overwritten');
    await duplicate.body?.cancel(); checks.push('immutable artifact');
    const promoted = await command('promote', {manifest: signed, expectedSequence: 0});
    if (promoted.sequence !== 1) throw Error('Initial promotion failed');
    sequence = 1; checks.push('signed promotion');

    let offered;
    for (let attempt = 0; attempt < 20; attempt++) {
      offered = await jsonResponse(await request(config.checkUrl, {method: 'POST',
        headers: {'Content-Type': 'application/json'}, body: JSON.stringify(selector)}));
      if (offered.manifest === signed) break;
      await delay(1000);
    }
    if (offered?.manifest !== signed) throw Error('Promoted release never appeared in metadata');
    await verifyManifest(offered.manifest, config, selector);
    checks.push('signed public metadata');
    const head = await request(artifact.url, {method: 'HEAD'});
    if (head.status !== 200 || Number(head.headers.get('content-length')) !== artifact.bytes) throw Error('HEAD size mismatch');
    await head.body?.cancel();
    const part = await request(artifact.url, {method: 'GET', headers: {Range: 'bytes=0-0'}});
    if (part.status !== 206 || part.headers.get('content-range') !== `bytes 0-0/${artifact.bytes}` ||
        (await part.arrayBuffer()).byteLength !== 1) throw Error('Byte range mismatch');
    const full = await request(artifact.url, {method: 'GET'});
    if (full.status !== 200 || digest(Buffer.from(await full.arrayBuffer())) !== artifact.sha256) throw Error('Artifact hash mismatch');
    checks.push('HEAD, ranges, and full artifact hash');

    const withdrawals = [randomUUID(), randomUUID()].map(id =>
      signJws(manifest('withdraw', 2, id), identity.signing, config.keyId));
    const races = await Promise.all(withdrawals.map(value => publish(signCommand('promote',
      {manifest: value, expectedSequence: 1}))));
    const codes = races.map(response => response.status).sort();
    await Promise.all(races.map(response => response.body?.cancel()));
    if (codes.join(',') !== '200,409') throw Error('Concurrent promotions did not conflict');
    sequence = 2; checks.push('atomic competing promotion');

    const rollback = signJws(manifest('release', 3, randomUUID()), identity.signing, config.keyId);
    await command('reserve', {manifest: rollback});
    const restored = await command('promote', {manifest: rollback, expectedSequence: 2});
    if (restored.sequence !== 3) throw Error('Rollback instruction failed');
    sequence = 3; checks.push('rollback reuses verified bytes');
  } finally {
    if (sequence) {
      const current = await status().catch(() => null);
      if (current && current.sequence >= sequence) {
        const next = current.sequence + 1;
        const withdrawal = signJws(manifest('withdraw', next, randomUUID()), identity.signing, config.keyId);
        await command('promote', {manifest: withdrawal, expectedSequence: current.sequence});
        checks.push('synthetic channel withdrawn');
      }
    }
  }
  return {mode: 'isolated-write', releaseId, checks};
}
