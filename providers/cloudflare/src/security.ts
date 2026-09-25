import {OTA_ABSOLUTE_LIMITS} from './protocol.ts';

export class Failure extends Error {
  constructor(readonly status: number, code: string) { super(code); }
}
export function fail(status: number, code: string): never { throw new Failure(status, code); }

export const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, PUT, GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, range, if-range, x-direct-ota-upload',
  'Access-Control-Expose-Headers': 'content-range, content-length, etag, accept-ranges',
};

export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {status, headers: {...cors,
    'Content-Type': 'application/json', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'}});
}

export function problem(error: unknown): Response {
  if (error instanceof Failure) return json({error: error.message}, error.status);
  // D1 constraint/uniqueness errors contain SQL internals; keep those server-side.
  return json({error: 'OTA_UNAVAILABLE'}, 503);
}

export async function readBytes(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) fail(413, 'BODY_TOO_LARGE');
  if (!request.body) fail(400, 'EMPTY_BODY');
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) fail(413, 'BODY_TOO_LARGE');
      parts.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  if (declared !== null && size !== Number(declared)) fail(400, 'BODY_LENGTH_MISMATCH');
  const output = new Uint8Array(new ArrayBuffer(size));
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}

export async function readJson(request: Request, limit: number): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') fail(400, 'INVALID_REQUEST');
  try { return JSON.parse(new TextDecoder('utf-8', {fatal: true, ignoreBOM: false}).decode(await readBytes(request, limit))); }
  catch (error) { if (error instanceof Failure) throw error; fail(400, 'INVALID_REQUEST'); }
}

export function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) fail(503, 'OTA_UNAVAILABLE');
  try { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); }
  catch { fail(503, 'OTA_UNAVAILABLE'); }
}

function base64url(bytes: Uint8Array): string {
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function decodeUrl(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) fail(403, 'UPLOAD_DENIED');
  let decoded: Uint8Array<ArrayBuffer>;
  try { decoded = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)), c => c.charCodeAt(0)); }
  catch { fail(403, 'UPLOAD_DENIED'); }
  if (base64url(decoded) !== value) fail(403, 'UPLOAD_DENIED');
  return decoded;
}

async function uploadKey(secret: string): Promise<CryptoKey> {
  const bytes = fromBase64(secret);
  if (bytes.length !== 32 || btoa(String.fromCharCode(...bytes)) !== secret) fail(503, 'OTA_UNAVAILABLE');
  return crypto.subtle.importKey('raw', bytes, {name: 'HMAC', hash: 'SHA-256'}, false, ['sign', 'verify']);
}

export interface UploadClaim {path: string; sha256: string; bytes: number; releaseId: string; exp: number}

export async function makeUploadToken(secret: string, claim: UploadClaim): Promise<string> {
  const encoded = base64url(new TextEncoder().encode(JSON.stringify(claim)));
  const signature = await crypto.subtle.sign('HMAC', await uploadKey(secret), new TextEncoder().encode(encoded));
  return encoded + '.' + base64url(new Uint8Array(signature));
}

export async function verifyUploadToken(secret: string, token: string): Promise<UploadClaim> {
  if (token.length > 1024 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) fail(403, 'UPLOAD_DENIED');
  const [encoded, mac] = token.split('.');
  if (decodeUrl(mac).length !== 32 || !await crypto.subtle.verify('HMAC', await uploadKey(secret), decodeUrl(mac), new TextEncoder().encode(encoded))) fail(403, 'UPLOAD_DENIED');
  let claim: UploadClaim;
  try { claim = JSON.parse(new TextDecoder('utf-8', {fatal: true, ignoreBOM: false}).decode(decodeUrl(encoded))) as UploadClaim; }
  catch { fail(403, 'UPLOAD_DENIED'); }
  if (!claim || typeof claim !== 'object' || Object.keys(claim).sort().join(',') !== 'bytes,exp,path,releaseId,sha256' ||
      typeof claim.path !== 'string' || typeof claim.sha256 !== 'string' || typeof claim.releaseId !== 'string' ||
      !Number.isSafeInteger(claim.bytes) || claim.bytes < 1 || claim.bytes > OTA_ABSOLUTE_LIMITS.archiveBytes ||
      !Number.isSafeInteger(claim.exp) || claim.exp <= Date.now() || claim.exp > Date.now() + 900000) fail(403, 'UPLOAD_DENIED');
  return claim;
}

export async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
}
