import {randomUUID} from 'node:crypto';
import {signJws} from './crypto.mjs';

export async function boundedJson(response, limit = 32768) {
  if (!response.body) throw new Error('Empty server response');
  const reader = response.body.getReader(); let bytes = 0; const chunks = [];
  try {
    while (true) { const {done, value} = await reader.read(); if (done) break; bytes += value.length;
      if (bytes > limit) throw new Error('Server response too large'); chunks.push(Buffer.from(value)); }
  } finally { await reader.cancel(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export async function command(config, identity, action, body, fetcher = fetch) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const iat = Math.floor(Date.now() / 1000);
    const signed = signJws({protocol: 1, appId: config.appId, aud: 'direct-ota-publish', action,
      iat, exp: iat + 60, nonce: randomUUID(), body}, identity.signing, config.keyId, 'DIRECT-OTA-PUBLISH');
    try {
      const response = await fetcher(config.publishUrl, {method: 'POST', redirect: 'error',
        headers: {'Content-Type': 'application/json'}, body: JSON.stringify({command: signed}), signal: AbortSignal.timeout(15000)});
      if (!response.ok) {
        await response.body?.cancel();
        const error = new Error(`Publish service returned HTTP ${response.status}`);
        error.retryable = response.status === 429 || response.status >= 500;
        throw error;
      }
      return await boundedJson(response);
    } catch (error) {
      if (attempt === 2 || error.retryable === false || error instanceof SyntaxError) throw error;
      await new Promise(r => setTimeout(r, 500 * (2 ** attempt) + Math.random() * 200));
    }
  }
}
export function validateUpload(config, upload) {
  const url = new URL(upload?.url);
  if (upload.method !== 'PUT' || url.protocol !== 'https:' || url.username || url.password || url.hash || !config.uploadOrigins.includes(url.origin)) throw new Error('Untrusted upload destination');
  const headers = upload.headers || {};
  if (Object.keys(headers).some(k => !['content-type', 'x-upsert'].includes(k.toLowerCase())) || Object.values(headers).some(v => typeof v !== 'string' || /[\r\n]/.test(v))) throw new Error('Unexpected upload headers');
  return {url, headers};
}
