#!/usr/bin/env node
import {performance} from 'node:perf_hooks';
import {resolve} from 'node:path';
import {readConfig} from '../cli/config.mjs';
import {selector} from '../cli/releases.mjs';
import {verifyManifest} from '../dist/protocol.js';

const pairs = process.argv.slice(2);
if (!pairs.length || pairs.length % 2) throw Error('Usage: benchmark-check --project DIR --platform ios|android [--channel internal|production] [--requests 100] [--concurrency 10] [--allow-remote]');
const args = Object.fromEntries(Array.from({length: pairs.length / 2}, (_, i) => pairs.slice(i * 2, i * 2 + 2)));
if (Object.keys(args).some(key => !['--project', '--platform', '--channel', '--requests', '--concurrency', '--allow-remote'].includes(key)) ||
    !args['--project'] || !['ios', 'android'].includes(args['--platform']) ||
    (args['--channel'] && !['internal', 'production'].includes(args['--channel']))) throw Error('Invalid benchmark arguments');
const bounded = (value, fallback, max) => {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw Error(`Benchmark count must be 1–${max}`);
  return n;
};
const requests = bounded(args['--requests'], 100, 2000);
const concurrency = bounded(args['--concurrency'], 10, 100);
const root = resolve(args['--project']);
const config = await readConfig(root);
const url = new URL(config.checkUrl);
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && args['--allow-remote'] !== 'true')
  throw Error('Remote benchmarks require --allow-remote true and an approved request budget');
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && requests > 500)
  throw Error('Remote benchmark is capped at 500 requests per run');
const selected = await selector(root, {platform: args['--platform'], channel: args['--channel']});
const body = JSON.stringify(selected);
const maxResponseBytes = 24576;
async function readBoundedResponse(response) {
  if (!response.body) throw Error('empty response');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > maxResponseBytes) throw Error('oversized response');
    chunks.push(Buffer.from(chunk));
  }
  return {text: Buffer.concat(chunks).toString('utf8'), size};
}
const timings = [];
const failures = {};
let bytes = 0, next = 0, manifestCount = 0;
const started = performance.now();
async function worker() {
  while (next < requests) {
    next++;
    const begin = performance.now();
    try {
      const response = await fetch(url, {method: 'POST', redirect: 'error', cache: 'no-store',
        headers: {'Content-Type': 'application/json'}, body, signal: AbortSignal.timeout(10000)});
      const {text, size} = await readBoundedResponse(response);
      const elapsed = performance.now() - begin;
      bytes += size;
      if (!response.ok) throw Error(`HTTP ${response.status}`);
      const result = JSON.parse(text);
      if (!result || typeof result !== 'object' || !Object.hasOwn(result, 'manifest')) throw Error('invalid response');
      if (result.manifest !== null) {
        await verifyManifest(result.manifest, config, selected);
        manifestCount++;
      }
      timings.push(elapsed);
    } catch (error) {
      const label = error.name === 'TimeoutError' ? 'timeout' : String(error.message).slice(0, 80);
      failures[label] = (failures[label] ?? 0) + 1;
    }
  }
}
await Promise.all(Array.from({length: Math.min(concurrency, requests)}, worker));
timings.sort((a, b) => a - b);
const percentile = p => timings.length ? Math.round(timings[Math.ceil(p * timings.length) - 1] * 100) / 100 : null;
const seconds = (performance.now() - started) / 1000;
console.log(JSON.stringify({provider: url.origin, platform: selected.platform, channel: selected.channel,
  requests, concurrency, successes: timings.length, failures, signedManifests: manifestCount,
  seconds: Math.round(seconds * 100) / 100, requestsPerSecond: Math.round(requests / seconds * 100) / 100,
  responseBytes: bytes, latencyMs: {p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99)}}, null, 2));
if (timings.length !== requests) process.exitCode = 1;
