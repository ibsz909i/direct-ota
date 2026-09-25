/** Portable HTTP admission for Direct OTA providers. Persistence must be atomic in the adapter. */
import {
  exactKeys, object, validateSelector, validateTrust, validateHistoryRequest, verifyManifest,
  verifyPublishCommand, OTA_UUID, type OtaManifest, type OtaSelector, type OtaTrust, type OtaHistoryRequest, type OtaHistoryItem,
} from './protocol.js';

export class ProviderError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
export function providerFail(status: number, code: string): never {
  throw new ProviderError(status, code);
}

export interface ProviderHead { sequence: number; manifest: string | null }
export interface ProviderUpload { url: string; method: 'PUT'; headers: Record<string, string> }
export interface ProviderReservation { releaseId: string; uploadRequired: boolean; upload?: ProviderUpload }
export interface ProviderPromotion { sequence: number; releaseId: string }
export interface ProviderHealth { releaseId: string; counts: Record<string, number>; sampledSuccessRate: number;
  metrics?: Record<string,{measured:number;durationMs:number;bytes:number;retries:number;maxDurationMs:number;
    connections?:{wifi:number;cellular:number;unknown:number}}> }
export interface ProviderHistory { items: OtaHistoryItem[]; nextCursor: number|null; scope: 'remote' }

export interface ProviderAdapter {
  /** Must not write on a check. Unknown selectors return null. */
  check(selector: OtaSelector): Promise<string | null>;
  status(selector: OtaSelector): Promise<ProviderHead>;
  /** Must atomically reject replay; retain nonces beyond the signed command window. */
  consumeNonce(nonce: string, expiresAtMs: number): Promise<void>;
  health?(releaseId: string): Promise<ProviderHealth>;
  history?(request: OtaHistoryRequest): Promise<ProviderHistory>;
  inspect?(releaseId: string): Promise<OtaHistoryItem | null>;
  /** Must reserve immutable paths and verify an existing object's hash. */
  reserve(signed: string, manifest: OtaManifest & {action: 'release'}): Promise<ProviderReservation>;
  /** Must rehash artifacts and perform an atomic sequence compare-and-swap. */
  promote(signed: string, manifest: OtaManifest, expectedSequence: number): Promise<ProviderPromotion>;
  /** Provider-specific immutable artifact and scoped upload transport. */
  route?(request: Request, url: URL, publisherEnabled: boolean): Promise<Response | null>;
}

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, PUT, GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, range, if-range, x-direct-ota-upload',
  'Access-Control-Expose-Headers': 'content-range, content-length, etag, accept-ranges',
};
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {status, headers: {...cors,
    'Content-Type': 'application/json', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'}});
}
function problem(error: unknown): Response {
  return error instanceof ProviderError ? json({error: error.code}, error.status) :
    json({error: 'OTA_UNAVAILABLE'}, 503);
}
async function readJson(request: Request, limit: number): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') providerFail(400, 'INVALID_REQUEST');
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) providerFail(413, 'BODY_TOO_LARGE');
  if (!request.body) providerFail(400, 'INVALID_REQUEST');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) providerFail(413, 'BODY_TOO_LARGE');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const body = new Uint8Array(size); let offset = 0;
  for (const part of chunks) { body.set(part, offset); offset += part.length; }
  try { return JSON.parse(new TextDecoder('utf-8', {fatal: true, ignoreBOM: false}).decode(body)); }
  catch { providerFail(400, 'INVALID_REQUEST'); }
}

/** The adapter owns storage, upload capabilities, and transactional state. */
export function createProvider(trust: OtaTrust, adapter: ProviderAdapter,
  options: {publisherEnabled?: boolean} = {}): {fetch(request: Request): Promise<Response>} {
  validateTrust(trust);
  const publisherEnabled = options.publisherEnabled !== false;
  return {async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === 'OPTIONS') return new Response(null, {status: 204, headers: cors});
      if (request.method === 'POST' && !url.search && url.pathname === '/check') {
        let selected: OtaSelector;
        try { selected = validateSelector(await readJson(request, 512)); }
        catch (error) { if (error instanceof ProviderError) throw error; providerFail(400, 'INVALID_REQUEST'); }
        const manifest = publisherEnabled ? await adapter.check(selected) : null;
        if (manifest !== null) await verifyManifest(manifest, trust, selected);
        return json({manifest});
      }
      if (request.method === 'POST' && !url.search && url.pathname === '/publish') {
        if (!publisherEnabled) providerFail(403, 'PUBLISHER_DISABLED');
        let command;
        try {
          const envelope = object(await readJson(request, 24576));
          exactKeys(envelope, ['command']);
          command = await verifyPublishCommand(envelope.command as string, trust);
        } catch (error) { if (error instanceof ProviderError) throw error; providerFail(401, 'INVALID_SIGNATURE'); }
        await adapter.consumeNonce(command.nonce, command.exp * 1000);
        if (command.action === 'health') {
          let releaseId: string;
          try { exactKeys(command.body, ['releaseId']); releaseId = command.body.releaseId as string;
            if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(releaseId))
              providerFail(400, 'INVALID_REQUEST');
          } catch (error) { if (error instanceof ProviderError) throw error; providerFail(400, 'INVALID_REQUEST'); }
          if (!adapter.health) providerFail(404, 'NOT_FOUND');
          return json(await adapter.health(releaseId));
        }
        if (command.action === 'status') {
          let selected: OtaSelector;
          try { selected = validateSelector(command.body); }
          catch { providerFail(400, 'INVALID_REQUEST'); }
          return json(await adapter.status(selected));
        }
        if (command.action === 'history') {
          let query: OtaHistoryRequest;
          try { query=validateHistoryRequest(command.body); }
          catch { providerFail(400,'INVALID_REQUEST'); }
          if (!adapter.history) providerFail(404,'NOT_FOUND');
          return json(await adapter.history(query));
        }
        if (command.action === 'inspect') {
          let releaseId: string;
          try { exactKeys(command.body,['releaseId']); releaseId=command.body.releaseId as string;
            if (typeof releaseId!=='string'||!OTA_UUID.test(releaseId)) providerFail(400,'INVALID_REQUEST'); }
          catch(error) { if(error instanceof ProviderError)throw error;providerFail(400,'INVALID_REQUEST'); }
          if (!adapter.inspect) providerFail(404,'NOT_FOUND');
          const item=await adapter.inspect(releaseId);
          if (!item) providerFail(404,'NOT_FOUND');
          return json(item);
        }
        let manifest: OtaManifest;
        try {
          exactKeys(command.body, command.action === 'reserve' ? ['manifest'] : ['manifest', 'expectedSequence']);
          manifest = await verifyManifest(command.body.manifest as string, trust);
        } catch { providerFail(400, 'INVALID_MANIFEST'); }
        const signed = command.body.manifest as string;
        if (command.action === 'reserve') {
          if (manifest.action !== 'release') providerFail(400, 'NO_ARTIFACT');
          return json(await adapter.reserve(signed, manifest));
        }
        const expected = command.body.expectedSequence;
        if (!Number.isSafeInteger(expected) || (expected as number) < 0 ||
            manifest.sequence !== (expected as number) + 1) providerFail(400, 'INVALID_SEQUENCE');
        return json(await adapter.promote(signed, manifest, expected as number));
      }
      const routed = await adapter.route?.(request, url, publisherEnabled);
      if (routed) return routed;
      providerFail(404, 'NOT_FOUND');
    } catch (error) { return problem(error); }
  }};
}
