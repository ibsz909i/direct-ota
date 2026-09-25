import {createHash} from 'node:crypto';
import {verifyManifest, effectiveLimits} from '../dist/protocol.js';
import {boundedJson} from './transport.mjs';
import {selector} from './releases.mjs';

async function request(url, options) {
  const response = await fetch(url, {...options, redirect: 'error', signal: AbortSignal.timeout(30000)});
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Remote ${options.method} returned HTTP ${response.status}`);
  }
  return response;
}

async function readArtifact(response, expectedBytes, maxBytes) {
  if (Number(response.headers.get('content-length')) !== expectedBytes || expectedBytes > maxBytes) {
    await response.body?.cancel();
    throw new Error('Remote artifact size differs from the signed manifest');
  }
  const hash = createHash('sha256');
  let bytes = 0, firstByte;
  for await (const chunk of response.body) {
    if (firstByte === undefined && chunk.length) firstByte = chunk[0];
    bytes += chunk.length;
    if (bytes > expectedBytes) throw new Error('Remote artifact exceeded its signed size');
    hash.update(chunk);
  }
  if (bytes !== expectedBytes) throw new Error('Remote artifact ended before its signed size');
  return {sha256: hash.digest('hex'), firstByte};
}

/** Check the deployed public endpoint and actual distributed bytes without publishing. */
export async function verifyRemote(root, config, options) {
  if (!options.platform) throw new Error('Remote doctor needs --platform ios|android');
  const selected = await selector(root, options);
  const checked = await request(config.checkUrl, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(selected)});
  const result = await boundedJson(checked);
  if (!result || typeof result !== 'object' || Object.keys(result).length !== 1 ||
      !(result.manifest === null || typeof result.manifest === 'string')) {
    throw new Error('Remote check response has an invalid shape');
  }
  if (result.manifest === null) return {...selected, release: null, checks: ['metadata reachable']};
  const manifest = await verifyManifest(result.manifest, config, selected);
  if (manifest.action === 'withdraw') return {...selected, release: null, sequence: manifest.sequence, checks: ['signed withdrawal verified']};
  const head = await request(manifest.artifact.url, {method: 'HEAD'});
  if (Number(head.headers.get('content-length')) !== manifest.artifact.bytes) {
    throw new Error('Remote artifact HEAD size differs from the signed manifest');
  }
  const first = await fetch(manifest.artifact.url, {method: 'GET', headers: {Range: 'bytes=0-0'},
    redirect: 'error', signal: AbortSignal.timeout(30000)});
  if (first.status !== 206 || first.headers.get('content-range') !== `bytes 0-0/${manifest.artifact.bytes}`) {
    await first.body?.cancel();
    throw new Error('Remote artifact does not support the required byte ranges');
  }
  let rangeBytes = 0, rangeByte;
  for await (const chunk of first.body) {
    rangeBytes += chunk.length;
    if (rangeBytes > 1) throw new Error('Remote byte range returned too many bytes');
    rangeByte = chunk[0];
  }
  if (rangeBytes !== 1) throw new Error('Remote byte range did not return one byte');
  const full = await request(manifest.artifact.url, {method: 'GET'});
  const artifact = await readArtifact(full, manifest.artifact.bytes, effectiveLimits(config).archiveBytes);
  if (artifact.sha256 !== manifest.artifact.sha256 || artifact.firstByte !== rangeByte) {
    throw new Error('Remote artifact hash differs from the signed manifest');
  }
  return {...selected, release: manifest.releaseId, sequence: manifest.sequence,
    checks: ['signed metadata verified', 'artifact size verified', 'byte ranges verified', 'artifact SHA-256 verified']};
}
