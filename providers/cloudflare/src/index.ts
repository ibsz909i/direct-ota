import {exactKeys, object, validateSelector, validateTrust, validateHistoryRequest, OTA_UUID, verifyManifest,
  verifyPublishCommand, type OtaArtifact, type OtaManifest,
  type OtaTrust} from './protocol.ts';
import {cors, fail, json, makeUploadToken, problem, readBytes, readJson, sha256,
  verifyUploadToken, type UploadClaim} from './security.ts';
import {consumeCommand, head, history, inspect as inspectReleaseState, promote, promotedPath, releaseById, reserve} from './state.ts';
import {catalogManifest, invalidateCatalog} from './catalog.ts';
import {OTA_SUCCESS_SAMPLE_RATE, validateEvent} from './telemetry.ts';

function configuration(env: Env): OtaTrust {
  let trust: OtaTrust;
  try { trust = validateTrust(JSON.parse(env.OTA_TRUST_JSON ?? 'null') as OtaTrust); }
  catch { fail(503, 'OTA_UNAVAILABLE'); }
  if (!trust.artifactBaseUrl.endsWith('/artifacts') ||
      new URL(trust.artifactBaseUrl).pathname !== '/artifacts' ||
      !env.OTA_UPLOAD_SECRET) fail(503, 'OTA_UNAVAILABLE');
  return trust;
}

async function inspect(bucket: R2Bucket, artifact: OtaArtifact): Promise<boolean> {
  const info = await bucket.head(artifact.path);
  if (!info) return false;
  if (info.size !== artifact.bytes) fail(409, 'ARTIFACT_CONFLICT');
  const object = await bucket.get(artifact.path);
  if (!object || object.size !== artifact.bytes) fail(409, 'ARTIFACT_CONFLICT');
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.length !== artifact.bytes || await sha256(bytes) !== artifact.sha256) fail(409, 'ARTIFACT_CONFLICT');
  return true;
}

async function check(request: Request, env: Env, trust: OtaTrust): Promise<Response> {
  const selected = validateSelector(await readJson(request, 512));
  if (String(env.OTA_PUBLISHER_ENABLED) === 'false') return json({manifest: null});
  return json({manifest: await catalogManifest(env.DB, trust, selected)});
}

async function publishing(request: Request, env: Env, trust: OtaTrust): Promise<Response> {
  if (String(env.OTA_PUBLISHER_ENABLED) === 'false') fail(403, 'PUBLISHER_DISABLED');
  const envelope = object(await readJson(request, 24576));
  let command;
  try { exactKeys(envelope, ['command']); command = await verifyPublishCommand(envelope.command as string, trust); }
  catch { fail(401, 'INVALID_SIGNATURE'); }
  await consumeCommand(env.DB, command.nonce, command.exp);
  if (command.action === 'health') {
    let releaseId: string;
    try { exactKeys(command.body, ['releaseId']); releaseId = command.body.releaseId as string;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(releaseId)) throw Error();
    } catch { fail(400, 'INVALID_REQUEST'); }
    const rows = await env.DB.prepare('SELECT event, count, measured, duration_ms, bytes, retries, max_duration_ms, wifi, cellular, unknown_connection FROM event_totals WHERE release_id = ? LIMIT 16')
      .bind(releaseId).all<{event: string; count: number; measured: number; duration_ms: number; bytes: number; retries: number; max_duration_ms: number; wifi: number; cellular: number; unknown_connection: number}>();
    return json({releaseId, counts: Object.fromEntries(rows.results.map(row => [row.event, row.count])),
      metrics: Object.fromEntries(rows.results.map(row => [row.event, {measured:row.measured,durationMs:row.duration_ms,
        bytes:row.bytes,retries:row.retries,maxDurationMs:row.max_duration_ms,
        connections:{wifi:row.wifi,cellular:row.cellular,unknown:row.unknown_connection}}])),
      sampledSuccessRate: OTA_SUCCESS_SAMPLE_RATE});
  }
  if (command.action === 'status') {
    let selected;
    try { selected = validateSelector(command.body); }
    catch { fail(400, 'INVALID_REQUEST'); }
    return json(await head(env.DB, selected));
  }
  if (command.action === 'history') {
    let query;
    try { query=validateHistoryRequest(command.body); } catch { fail(400,'INVALID_REQUEST'); }
    return json(await history(env.DB,query));
  }
  if (command.action === 'inspect') {
    let releaseId;
    try { exactKeys(command.body,['releaseId']);releaseId=command.body.releaseId;
      if(typeof releaseId!=='string'||!OTA_UUID.test(releaseId))throw Error(); }
    catch { fail(400,'INVALID_REQUEST'); }
    const item=await inspectReleaseState(env.DB,releaseId);
    if(!item)fail(404,'NOT_FOUND');
    return json(item);
  }
  let manifest: OtaManifest;
  try {
    exactKeys(command.body, command.action === 'reserve' ? ['manifest'] : ['manifest', 'expectedSequence']);
    manifest = await verifyManifest(command.body.manifest as string, trust);
  } catch { fail(400, 'INVALID_MANIFEST'); }
  const signed = command.body.manifest as string;
  if (command.action === 'reserve') {
    if (manifest.action !== 'release') fail(400, 'NO_ARTIFACT');
    const uploaded = await inspect(env.ARTIFACTS, manifest.artifact);
    await reserve(env.DB, signed, manifest);
    if (uploaded) return json({releaseId: manifest.releaseId, uploadRequired: false});
    const claim: UploadClaim = {path: manifest.artifact.path, sha256: manifest.artifact.sha256,
      bytes: manifest.artifact.bytes, releaseId: manifest.releaseId, exp: Date.now() + 900000};
    const origin = trust.artifactBaseUrl.slice(0, -'/artifacts'.length);
    return json({releaseId: manifest.releaseId, uploadRequired: true,
      upload: {url: origin + '/upload', method: 'PUT', headers: {
        'Content-Type': 'application/zip',
        'X-Direct-OTA-Upload': await makeUploadToken(env.OTA_UPLOAD_SECRET, claim),
      }}});
  }
  const expected = command.body.expectedSequence;
  if (!Number.isSafeInteger(expected) || (expected as number) < 0 || manifest.sequence !== (expected as number) + 1) fail(400, 'INVALID_SEQUENCE');
  if (manifest.action === 'release' && !await inspect(env.ARTIFACTS, manifest.artifact)) fail(400, 'INCOMPLETE_ARTIFACT');
  const result = await promote(env.DB, signed, manifest, expected as number);
  invalidateCatalog();
  return json(result);
}

async function upload(request: Request, env: Env, url: URL): Promise<Response> {
  if (url.search) fail(403, 'UPLOAD_DENIED');
  const claim = await verifyUploadToken(env.OTA_UPLOAD_SECRET,
    request.headers.get('x-direct-ota-upload') ?? '');
  const release = await releaseById(env.DB, claim.releaseId);
  if (!release || release.promoted || release.expires <= Date.now() || release.path !== claim.path ||
      release.sha256 !== claim.sha256 || release.bytes !== claim.bytes) fail(403, 'UPLOAD_DENIED');
  if (!['application/zip', 'application/octet-stream'].includes(request.headers.get('content-type')?.split(';')[0].trim() ?? '')) fail(400, 'INVALID_CONTENT_TYPE');
  const bytes = await readBytes(request, claim.bytes);
  if (bytes.length !== claim.bytes || await sha256(bytes) !== claim.sha256) fail(400, 'ARTIFACT_MISMATCH');
  const digest = Uint8Array.from(claim.sha256.match(/../g)!, part => parseInt(part, 16));
  const created = await env.ARTIFACTS.put(claim.path, bytes, {
    onlyIf: new Headers({'If-None-Match': '*'}), sha256: digest,
    httpMetadata: {contentType: 'application/zip', cacheControl: 'public, max-age=31536000, immutable'},
  });
  if (!created) fail(409, 'IMMUTABLE_ARTIFACT');
  return json({uploaded: true}, 201);
}

async function event(request: Request, env: Env): Promise<Response> {
  if (String(env.OTA_EVENTS_ENABLED) !== 'true') fail(404, 'NOT_FOUND');
  let report;
  try { report = validateEvent(await readJson(request, 256)); }
  catch { fail(400, 'INVALID_EVENT'); }
  const minute = Math.floor(Date.now() / 60000);
  const admitted = await env.DB.prepare(`UPDATE event_window SET minute = ?,
    events = CASE WHEN minute = ? THEN events + 1 ELSE 1 END
    WHERE id = 1 AND (minute != ? OR events < 120)`)
    .bind(minute, minute, minute).run();
  if (admitted.meta.changes !== 1) fail(429, 'RATE_LIMITED');
  const release = await releaseById(env.DB, report.releaseId);
  if (!release?.promoted) fail(404, 'NOT_FOUND');
  const metrics=report.metrics;
  await env.DB.prepare(`INSERT INTO event_totals(release_id, event, count, measured, duration_ms, bytes, retries, max_duration_ms, wifi, cellular, unknown_connection)
    VALUES(?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(release_id, event) DO UPDATE SET count = count + 1, measured = measured + excluded.measured,
      duration_ms = duration_ms + excluded.duration_ms, bytes = bytes + excluded.bytes,
      retries = retries + excluded.retries, max_duration_ms = max(max_duration_ms, excluded.max_duration_ms),
      wifi = wifi + excluded.wifi, cellular = cellular + excluded.cellular,
      unknown_connection = unknown_connection + excluded.unknown_connection`)
    .bind(report.releaseId, report.event, metrics ? 1 : 0, metrics?.durationMs ?? 0,
      metrics?.bytes ?? 0, metrics?.retries ?? 0, metrics?.durationMs ?? 0,
      metrics?.connection==='wifi'?1:0,metrics?.connection==='cellular'?1:0,metrics?.connection==='unknown'?1:0).run();
  return new Response(null, {status: 204, headers: cors});
}

function range(value: string, size: number): {offset: number; length: number} | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix < 1) return null;
    return {offset: Math.max(0, size - suffix), length: Math.min(size, suffix)};
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return null;
  return {offset: start, length: Math.min(end, size - 1) - start + 1};
}

async function artifact(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname.slice('/artifacts/'.length);
  if (url.search || !/^(ios|android)\/[0-9a-f]{64}\/[0-9a-f-]{36}\/[0-9a-f]{64}\.zip$/.test(path)) fail(404, 'NOT_FOUND');
  const release = await promotedPath(env.DB, path);
  if (!release) fail(404, 'NOT_FOUND');
  const info = await env.ARTIFACTS.head(path);
  if (!info || info.size !== release.bytes) fail(503, 'ARTIFACT_UNAVAILABLE');
  const headers = new Headers({...cors, 'Content-Type': 'application/zip',
    'Cache-Control': 'public, max-age=31536000, immutable', 'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff', 'ETag': info.httpEtag});
  if (request.method === 'HEAD') {
    headers.set('Content-Length', String(info.size));
    return new Response(null, {status: 200, headers});
  }
  const requested = request.headers.get('range');
  const ifRange = request.headers.get('if-range');
  const part = requested && (!ifRange || ifRange === info.httpEtag) ? range(requested, info.size) : undefined;
  if (part === null) {
    headers.set('Content-Range', `bytes */${info.size}`);
    return new Response(null, {status: 416, headers});
  }
  const object = await env.ARTIFACTS.get(path, part ? {range: part} : undefined);
  if (!object || object.size !== release.bytes) fail(503, 'ARTIFACT_UNAVAILABLE');
  if (part) headers.set('Content-Range', `bytes ${part.offset}-${part.offset + part.length - 1}/${info.size}`);
  headers.set('Content-Length', String(part?.length ?? info.size));
  return new Response(object.body, {status: part ? 206 : 200, headers});
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const trust = configuration(env);
      const url = new URL(request.url);
      if (request.method === 'OPTIONS') return new Response(null, {status: 204, headers: cors});
      if (request.method === 'POST' && !url.search && url.pathname === '/check') return await check(request, env, trust);
      if (request.method === 'POST' && !url.search && url.pathname === '/publish') return await publishing(request, env, trust);
      if (request.method === 'POST' && !url.search && url.pathname === '/events') return await event(request, env);
      if (request.method === 'PUT' && url.pathname === '/upload') return await upload(request, env, url);
      if (['GET', 'HEAD'].includes(request.method) && url.pathname.startsWith('/artifacts/')) return await artifact(request, env, url);
      fail(404, 'NOT_FOUND');
    } catch (error) { return problem(error); }
  },
} satisfies ExportedHandler<Env>;
