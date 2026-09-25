import {createHash, createHmac, randomUUID, timingSafeEqual} from 'node:crypto';
import type {Firestore} from 'firebase-admin/firestore';
import {getStorage} from 'firebase-admin/storage';
import {createProvider, providerFail, type ProviderAdapter} from './provider.js';
import {OTA_SUCCESS_SAMPLE_RATE, validateEvent} from './telemetry.js';
import {OTA_ABSOLUTE_LIMITS, OTA_HASH, OTA_UUID, validateTrust, verifyManifest, historyItem,
  type OtaArtifact, type OtaManifest, type OtaSelector, type OtaTrust} from './protocol.js';

type Bucket = ReturnType<ReturnType<typeof getStorage>['bucket']>;
const hash = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
const selectorId = (s: OtaSelector) => `${s.platform}_${s.channel}_${s.runtime}`;
const artifactId = (path: string) => hash(path);
const cors = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, range, if-range, x-direct-ota-upload',
  'Access-Control-Expose-Headers': 'content-range, content-length, etag, accept-ranges'};
const responseJson = (value: unknown, status = 200) => new Response(JSON.stringify(value), {status,
  headers: {...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'}});

interface Claim {path: string; sha256: string; bytes: number; releaseId: string; exp: number}
function secretBytes(secret: string): Buffer {
  if (!/^[A-Za-z0-9+/]{42}[A-Za-z0-9+/]={1}$/.test(secret)) throw Error('Upload secret must be 32 random bytes in base64');
  const bytes = Buffer.from(secret, 'base64');
  if (bytes.length !== 32 || bytes.toString('base64') !== secret) throw Error('Invalid upload secret');
  return bytes;
}
function capability(secret: Buffer, claim: Claim): string {
  const payload = Buffer.from(JSON.stringify(claim)).toString('base64url');
  return payload + '.' + createHmac('sha256', secret).update(payload).digest('base64url');
}
function verifyCapability(secret: Buffer, token: string): Claim {
  if (token.length > 1024 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) providerFail(403, 'UPLOAD_DENIED');
  const [payload, mac] = token.split('.');
  const signature = Buffer.from(mac, 'base64url');
  const expected = createHmac('sha256', secret).update(payload).digest();
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) providerFail(403, 'UPLOAD_DENIED');
  let claim: Claim;
  try { claim = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Claim; }
  catch { providerFail(403, 'UPLOAD_DENIED'); }
  if (!claim || typeof claim !== 'object' || Object.keys(claim).sort().join(',') !== 'bytes,exp,path,releaseId,sha256' ||
      typeof claim.path !== 'string' || typeof claim.sha256 !== 'string' || !OTA_HASH.test(claim.sha256) ||
      typeof claim.releaseId !== 'string' || !OTA_UUID.test(claim.releaseId) ||
      !Number.isSafeInteger(claim.bytes) || claim.bytes < 1 || claim.bytes > OTA_ABSOLUTE_LIMITS.archiveBytes ||
      !Number.isSafeInteger(claim.exp) || claim.exp <= Date.now() || claim.exp > Date.now() + 900000)
    providerFail(403, 'UPLOAD_DENIED');
  return claim;
}
async function readBytes(request: Request, limit: number): Promise<Uint8Array> {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) providerFail(413, 'BODY_TOO_LARGE');
  if (!request.body) providerFail(400, 'EMPTY_BODY');
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) {
    const {done, value} = await reader.read(); if (done) break;
    size += value.byteLength; if (size > limit) providerFail(413, 'BODY_TOO_LARGE'); chunks.push(value);
  }} finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const result = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  if (declared !== null && size !== Number(declared)) providerFail(400, 'BODY_LENGTH_MISMATCH');
  return result;
}
async function inspect(bucket: Bucket, artifact: OtaArtifact): Promise<boolean> {
  const file = bucket.file(artifact.path);
  try {
    const [metadata] = await file.getMetadata();
    if (Number(metadata.size) !== artifact.bytes) providerFail(409, 'ARTIFACT_CONFLICT');
    const [bytes] = await file.download();
    if (bytes.length !== artifact.bytes || hash(bytes) !== artifact.sha256) providerFail(409, 'ARTIFACT_CONFLICT');
    return true;
  } catch (error) { if ((error as {code?: number}).code === 404) return false; throw error; }
}
function range(value: string, size: number): {start: number; end: number} | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const count = Number(match[2]);
    if (!Number.isSafeInteger(count) || count < 1) return null;
    return {start: Math.max(0, size - count), end: size - 1};
  }
  const start = Number(match[1]), end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return null;
  return {start, end: Math.min(end, size - 1)};
}

/** Firebase Admin bypasses client rules. Use a dedicated project and a dedicated private bucket. */
export function createFirebaseProvider({db, bucket, trust, uploadSecret, publisherEnabled = true, eventsEnabled = false}:
  {db: Firestore; bucket: Bucket; trust: OtaTrust; uploadSecret: string; publisherEnabled?: boolean; eventsEnabled?: boolean}) {
  validateTrust(trust);
  const base = new URL(trust.artifactBaseUrl);
  if (base.pathname !== '/artifacts') throw Error('Firebase artifact URL must use Hosting /artifacts');
  const secret = secretBytes(uploadSecret);
  const heads = db.collection('direct_ota_heads');
  const releases = db.collection('direct_ota_releases');
  const artifacts = db.collection('direct_ota_artifacts');
  const audit = db.collection('direct_ota_audit');
  const eventTotals = db.collection('direct_ota_event_totals');
  const eventGate = db.collection('direct_ota_control').doc('event_gate');
  const gate = db.collection('direct_ota_control').doc('publisher_gate');
  const cache = new Map<string, {expires: number; manifest: string | null}>();
  const loading = new Map<string, Promise<string | null>>();
  const headRef = (s: OtaSelector) => heads.doc(selectorId(s));
  const status = async (s: OtaSelector) => {
    const current = await headRef(s).get();
    if (!current.exists) return {sequence: 0, manifest: null};
    const row = current.data()!;
    if (!Number.isSafeInteger(row.sequence) || typeof row.signed !== 'string') throw Error('Corrupt OTA channel head');
    return {sequence: row.sequence as number, manifest: row.signed as string};
  };
  const adapter: ProviderAdapter = {
    async check(s) {
      const key = selectorId(s), now = Date.now();
      const existing = cache.get(key);
      if (existing && existing.expires > now) return existing.manifest;
      let task = loading.get(key);
      if (!task) {
        task = status(s).then(({manifest}) => {
          if (cache.size >= 256) cache.delete(cache.keys().next().value!);
          cache.set(key, {manifest, expires: Date.now() + 15000});
          return manifest;
        }).finally(() => loading.delete(key));
        loading.set(key, task);
      }
      return task;
    },
    status,
    async history(query) {
      let request=audit.where('selector','==',selectorId(query)).orderBy('sequence','desc');
      if(query.beforeSequence!==undefined)request=request.where('sequence','<',query.beforeSequence);
      const snapshot=await request.limit(query.limit+1).get();
      const rows=snapshot.docs.slice(0,query.limit);
      const releasesById=rows.length?await db.getAll(...rows.map(row=>releases.doc(row.id))):[];
      const items=await Promise.all(releasesById.map(async row=>{
        const signed=row.data()?.signed;
        if(typeof signed!=='string'||!row.data()?.promoted)throw Error('Corrupt OTA release history');
        return historyItem(await verifyManifest(signed,trust,query));
      }));
      return {items,nextCursor:snapshot.docs.length>query.limit?items.at(-1)!.sequence:null,scope:'remote'};
    },
    async inspect(releaseId) {
      const [record,history]=await Promise.all([releases.doc(releaseId).get(),audit.doc(releaseId).get()]);
      const signed=record.data()?.signed;
      if(!history.exists||!record.data()?.promoted||typeof signed!=='string')return null;
      return historyItem(await verifyManifest(signed,trust));
    },
    async health(releaseId) {
      const snapshot = await eventTotals.doc(releaseId).get();
      const counts = snapshot.data()?.counts;
      return {releaseId, counts: counts && typeof counts === 'object' ? counts : {},
        metrics: snapshot.data()?.metrics ?? {},
        sampledSuccessRate: OTA_SUCCESS_SAMPLE_RATE};
    },
    async consumeNonce(nonce, expiresAtMs) {
      const now = Date.now();
      await db.runTransaction(async tx => {
        const snapshot = await tx.get(gate);
        const data = snapshot.data();
        const recent = Array.isArray(data?.recent) ? data.recent.filter((item: unknown) => {
          const value = item as {nonce?: unknown; at?: unknown};
          return typeof value?.nonce === 'string' && Number.isSafeInteger(value.at) && (value.at as number) > now - 300000;
        }) as {nonce: string; at: number}[] : [];
        if (recent.some(item => item.nonce === nonce)) providerFail(409, 'REPLAY');
        if (recent.filter(item => item.at > now - 60000).length >= 60) providerFail(429, 'RATE_LIMITED');
        if (expiresAtMs <= now || recent.length >= 300) providerFail(429, 'RATE_LIMITED');
        tx.set(gate, {recent: [...recent, {nonce, at: now}]});
      });
    },
    async reserve(signed, manifest) {
      const artifact = manifest.artifact;
      if (artifact.path.split('/')[2] !== manifest.releaseId) {
        const previous = await artifacts.doc(artifactId(artifact.path)).get();
        const row = previous.data();
        if (!row?.promoted || row.path !== artifact.path || row.sha256 !== artifact.sha256 ||
            row.bytes !== artifact.bytes || row.platform !== manifest.platform || row.runtime !== manifest.runtime)
          providerFail(400, 'UNKNOWN_ROLLBACK_ARTIFACT');
      }
      const uploaded = await inspect(bucket, artifact);
      const ref = releases.doc(manifest.releaseId);
      await db.runTransaction(async tx => {
        const prior = await tx.get(ref);
        if (prior.exists && prior.data()?.signed !== signed) providerFail(409, 'IMMUTABLE_RELEASE');
        if (!prior.exists) tx.create(ref, {signed, selector: selectorId(manifest),
          path: artifact.path, sha256: artifact.sha256, bytes: artifact.bytes,
          expires: Date.now() + 7200000, promoted: false});
        else if (!prior.data()?.promoted) tx.update(ref, {expires: Date.now() + 7200000});
      });
      if (uploaded) return {releaseId: manifest.releaseId, uploadRequired: false};
      const claim: Claim = {path: artifact.path, sha256: artifact.sha256, bytes: artifact.bytes,
        releaseId: manifest.releaseId, exp: Date.now() + 900000};
      return {releaseId: manifest.releaseId, uploadRequired: true,
        upload: {url: base.origin + '/upload', method: 'PUT', headers: {
          'Content-Type': 'application/zip', 'X-Direct-OTA-Upload': capability(secret, claim)}}};
    },
    async promote(signed, manifest, expectedSequence) {
      if (manifest.action === 'release' && !await inspect(bucket, manifest.artifact)) providerFail(400, 'INCOMPLETE_ARTIFACT');
      const releaseRef = releases.doc(manifest.releaseId), currentRef = headRef(manifest);
      const artifactRef = manifest.action === 'release' ? artifacts.doc(artifactId(manifest.artifact.path)) : null;
      const auditRef = audit.doc(manifest.releaseId);
      const result = await db.runTransaction(async tx => {
        const current = await tx.get(currentRef), release = await tx.get(releaseRef);
        const next = current.data();
        if (next?.signed === signed) return {sequence: manifest.sequence, releaseId: manifest.releaseId};
        const sequence = current.exists ? next?.sequence : 0;
        if (sequence !== expectedSequence) providerFail(409, 'SEQUENCE_CONFLICT');
        if (release.exists && (release.data()?.signed !== signed || release.data()?.promoted)) providerFail(409, 'IMMUTABLE_RELEASE');
        if (manifest.action === 'release') {
          const row = release.data();
          if (!row || row.path !== manifest.artifact.path || row.sha256 !== manifest.artifact.sha256 ||
              row.bytes !== manifest.artifact.bytes || row.expires <= Date.now()) providerFail(400, 'RESERVATION_REQUIRED');
        }
        if (!release.exists) tx.create(releaseRef, {signed, selector: selectorId(manifest),
          path: null, sha256: null, bytes: 0, expires: 0, promoted: true});
        else tx.update(releaseRef, {promoted: true});
        tx.set(currentRef, {sequence: manifest.sequence, signed, releaseId: manifest.releaseId});
        if (artifactRef && manifest.action === 'release') tx.set(artifactRef, {path: manifest.artifact.path,
          sha256: manifest.artifact.sha256, bytes: manifest.artifact.bytes,
          platform: manifest.platform, runtime: manifest.runtime, promoted: true});
        tx.create(auditRef, {sequence: manifest.sequence, selector: selectorId(manifest),
          action: manifest.action, at: Date.now()});
        return {sequence: manifest.sequence, releaseId: manifest.releaseId};
      });
      cache.delete(selectorId(manifest));
      return result;
    },
    async route(request, url, enabled) {
      if (request.method === 'POST' && url.pathname === '/events' && !url.search) {
        if (!eventsEnabled) providerFail(404, 'NOT_FOUND');
        if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') providerFail(400, 'INVALID_EVENT');
        let report;
        try { report = validateEvent(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(await readBytes(request, 256)))); }
        catch { providerFail(400, 'INVALID_EVENT'); }
        const minute = Math.floor(Date.now() / 60000);
        const releaseRef = releases.doc(report.releaseId), totalRef = eventTotals.doc(report.releaseId);
        await db.runTransaction(async tx => {
          const [gateRow, releaseRow, totalsRow] = await Promise.all([
            tx.get(eventGate), tx.get(releaseRef), tx.get(totalRef)]);
          if (!releaseRow.data()?.promoted) providerFail(404, 'NOT_FOUND');
          const gateData = gateRow.data();
          const count = gateData?.minute === minute ? gateData.count : 0;
          if (!Number.isSafeInteger(count) || count >= 120) providerFail(429, 'RATE_LIMITED');
          const prior = totalsRow.data()?.counts?.[report.event] ?? 0;
          if (!Number.isSafeInteger(prior) || prior < 0) throw Error('Corrupt OTA event total');
          const previous = totalsRow.data()?.metrics?.[report.event] ?? {};
          const bounded = (key: 'measured'|'durationMs'|'bytes'|'retries'|'maxDurationMs') => {
            const value = previous[key] ?? 0;
            if (!Number.isSafeInteger(value) || value < 0) throw Error('Corrupt OTA event metric');
            return value as number;
          };
          const metric = report.metrics;
          const aggregate = {measured:bounded('measured')+(metric ? 1 : 0),
            durationMs:bounded('durationMs')+(metric?.durationMs ?? 0),
            bytes:bounded('bytes')+(metric?.bytes ?? 0),
            retries:bounded('retries')+(metric?.retries ?? 0),
            maxDurationMs:Math.max(bounded('maxDurationMs'),metric?.durationMs ?? 0),
            connections:Object.fromEntries(['wifi','cellular','unknown'].map(type=>{
              const old=previous.connections?.[type]??0;
              if(!Number.isSafeInteger(old)||old<0)throw Error('Corrupt OTA event metric');
              return [type,old+(metric?.connection===type?1:0)];
            }))};
          if ([...Object.values(aggregate).filter(value=>typeof value==='number'),...Object.values(aggregate.connections)]
            .some(value => !Number.isSafeInteger(value))) throw Error('OTA event metric overflow');
          tx.set(eventGate, {minute, count: count + 1});
          tx.set(totalRef, {counts: {[report.event]: prior + 1}, metrics: {[report.event]: aggregate}}, {merge: true});
        });
        return new Response(null, {status: 204, headers: cors});
      }
      if (request.method === 'PUT' && url.pathname === '/upload') {
        if (!enabled) providerFail(403, 'PUBLISHER_DISABLED');
        if (url.search) providerFail(403, 'UPLOAD_DENIED');
        const claim = verifyCapability(secret, request.headers.get('x-direct-ota-upload') ?? '');
        const row = (await releases.doc(claim.releaseId).get()).data();
        if (!row || row.promoted || row.expires <= Date.now() || row.path !== claim.path ||
            row.sha256 !== claim.sha256 || row.bytes !== claim.bytes) providerFail(403, 'UPLOAD_DENIED');
        if (!['application/zip', 'application/octet-stream'].includes(request.headers.get('content-type')?.split(';')[0].trim() ?? ''))
          providerFail(400, 'INVALID_CONTENT_TYPE');
        const bytes = await readBytes(request, claim.bytes);
        if (bytes.length !== claim.bytes || hash(bytes) !== claim.sha256) providerFail(400, 'ARTIFACT_MISMATCH');
        const file = bucket.file(claim.path), releaseRef = releases.doc(claim.releaseId);
        const [alreadyExists] = await file.exists();
        if (alreadyExists) providerFail(409, 'IMMUTABLE_ARTIFACT');
        const lock = randomUUID(), now = Date.now();
        await db.runTransaction(async tx => {
          const current = (await tx.get(releaseRef)).data();
          if (!current || current.promoted || current.expires <= now ||
              current.path !== claim.path || current.sha256 !== claim.sha256 || current.bytes !== claim.bytes)
            providerFail(403, 'UPLOAD_DENIED');
          if (current.uploadLock && current.lockAt > now - 120000) providerFail(409, 'UPLOAD_BUSY');
          tx.update(releaseRef, {uploadLock: lock, lockAt: now});
        });
        try { await file.save(Buffer.from(bytes), {resumable: false,
          preconditionOpts: {ifGenerationMatch: 0},
          metadata: {contentType: 'application/zip', cacheControl: 'public, max-age=31536000, immutable'}}); }
        catch (error) {
          if ([409, 412].includes((error as {code?: number}).code ?? 0)) providerFail(409, 'IMMUTABLE_ARTIFACT');
          throw error;
        } finally {
          await db.runTransaction(async tx => {
            const current = (await tx.get(releaseRef)).data();
            if (current?.uploadLock === lock) tx.update(releaseRef, {uploadLock: null, lockAt: null});
          });
        }
        return responseJson({uploaded: true}, 201);
      }
      if (['GET', 'HEAD'].includes(request.method) && url.pathname.startsWith('/artifacts/')) {
        const path = url.pathname.slice('/artifacts/'.length);
        if (url.search || !/^(ios|android)\/[0-9a-f]{64}\/[0-9a-f-]{36}\/[0-9a-f]{64}\.zip$/.test(path)) providerFail(404, 'NOT_FOUND');
        const record = (await artifacts.doc(artifactId(path)).get()).data();
        if (!record?.promoted || record.path !== path) providerFail(404, 'NOT_FOUND');
        const file = bucket.file(path), [metadata] = await file.getMetadata();
        if (Number(metadata.size) !== record.bytes) providerFail(503, 'ARTIFACT_UNAVAILABLE');
        const etag = `"${record.sha256}"`, headers = new Headers({...cors,
          'Content-Type': 'application/zip', 'Cache-Control': 'public, max-age=31536000, immutable',
          'Accept-Ranges': 'bytes', 'ETag': etag, 'X-Content-Type-Options': 'nosniff'});
        const value = request.headers.get('range'), ifRange = request.headers.get('if-range');
        const part = value && (!ifRange || ifRange === etag) ? range(value, record.bytes) : undefined;
        if (part === null) { headers.set('Content-Range', `bytes */${record.bytes}`); return new Response(null, {status: 416, headers}); }
        headers.set('Content-Length', String(part ? part.end - part.start + 1 : record.bytes));
        if (part) headers.set('Content-Range', `bytes ${part.start}-${part.end}/${record.bytes}`);
        if (request.method === 'HEAD') return new Response(null, {status: part ? 206 : 200, headers});
        const [bytes] = await file.download(part ? {start: part.start, end: part.end} : undefined);
        if (bytes.length !== (part ? part.end - part.start + 1 : record.bytes)) providerFail(503, 'ARTIFACT_UNAVAILABLE');
        return new Response(new Uint8Array(bytes), {status: part ? 206 : 200, headers});
      }
      return null;
    },
  };
  return createProvider(trust, adapter, {publisherEnabled});
}
