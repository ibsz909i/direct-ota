import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {createHash, createHmac, randomBytes, randomUUID, timingSafeEqual} from 'node:crypto';
import {constants, unlinkSync} from 'node:fs';
import {mkdir, lstat, readFile, writeFile, open, link, unlink, readdir} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {pipeline} from 'node:stream/promises';
import {validateTrust, validateSelector, validateHistoryRequest, verifyManifest, verifyPublishCommand, object, exactKeys, OTA_UUID, historyItem} from '../../dist/protocol.js';

class Failure extends Error { constructor(status, code) { super(code); this.status = status; } }
const fail = (status, code) => { throw new Failure(status, code); };
const digest = value => createHash('sha256').update(value).digest('hex');
const selectorKey = s => `${s.platform}:${s.channel}:${s.runtime}`;
const cors = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST, GET, HEAD, OPTIONS','Access-Control-Allow-Headers':'content-type, range','Access-Control-Expose-Headers':'content-range, content-length, etag'};
function json(res, status, value) {
  if (res.destroyed) return;
  res.writeHead(status, {...cors,'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  res.end(JSON.stringify(value));
}
async function body(req, limit) {
  const declared = req.headers['content-length'];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > limit)) fail(413,'BODY_TOO_LARGE');
  const chunks = []; let size = 0;
  for await (const part of req) { size += part.length; if (size > limit) fail(413,'BODY_TOO_LARGE'); chunks.push(part); }
  return Buffer.concat(chunks);
}
async function requestJson(req, limit) {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') fail(400,'INVALID_REQUEST');
  try { return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await body(req,limit))); }
  catch (error) { if (error instanceof Failure) throw error; fail(400,'INVALID_REQUEST'); }
}
function rateGate(maximum, windowMs = 60000) {
  let count = 0, start = Date.now();
  return () => { const now = Date.now(); if (now - start >= windowMs) { start = now; count = 0; } return ++count <= maximum; };
}
async function privateDirectory(path) {
  await mkdir(path,{recursive:true,mode:0o700});
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== 'win32' && (info.mode & 0o077))) throw Error('OTA data directories require private permissions');
}

/** One service process per private dataDir. TLS and distributed admission belong at the proxy. */
export async function createOtaServer({trust, dataDir, uploadSecret, uploadBaseUrl, publisherEnabled = true, limits = {}}) {
  validateTrust(trust);
  trust = structuredClone(trust);
  if (!trust.artifactBaseUrl.endsWith('/artifacts')) throw Error('Node artifactBaseUrl must end in /artifacts');
  const publicUpload = uploadBaseUrl ?? trust.artifactBaseUrl.slice(0,-10) + '/upload';
  const uploadUrl = new URL(publicUpload);
  if (uploadUrl.protocol !== 'https:' || uploadUrl.username || uploadUrl.password || uploadUrl.search || uploadUrl.hash || uploadUrl.href !== publicUpload) throw Error('Upload URL must be canonical HTTPS');
  const cap = {requestsPerMinute:1200, publishPerMinute:60, concurrentRequests:64, concurrentUploads:2, maxReleases:10000, maxSelectors:256, maxStorageBytes:2*1024*1024*1024, ...limits};
  for (const value of Object.values(cap)) if (!Number.isSafeInteger(value) || value < 1) throw Error('Invalid server limits');
  const root = resolve(dataDir), files = join(root,'artifacts'), staging = join(root,'staging');
  await privateDirectory(root); await privateDirectory(files); await privateDirectory(staging);
  const lock = await open(join(root,'service.lock'),'wx',0o600).catch(()=>{ throw Error('OTA data directory is already locked; recover stale locks only after stopping its owner'); });
  await lock.writeFile(String(process.pid)); await lock.close();
  let db;
  try {
    // Only this process owns the directory. Incomplete files from a stopped process are never public.
    for (const name of await readdir(staging)) if (/^[0-9a-f-]{36}\.part$/.test(name)) await unlink(join(staging,name));
    const secretPath = join(root,'upload-secret');
    if (uploadSecret === undefined) {
      try { await writeFile(secretPath,randomBytes(32),{flag:'wx',mode:0o600}); } catch (e) { if (e.code !== 'EEXIST') throw e; }
      const info = await lstat(secretPath);
      if (!info.isFile() || info.isSymbolicLink() || (process.platform !== 'win32' && (info.mode & 0o077))) throw Error('Upload secret must be a private regular file');
      uploadSecret = await readFile(secretPath);
    }
    if (!(uploadSecret instanceof Uint8Array) || uploadSecret.length !== 32) throw Error('uploadSecret must contain 32 random bytes');
    const secret = Buffer.from(uploadSecret);
    const databasePath = join(root,'state.sqlite');
    try { const info = await lstat(databasePath); if (!info.isFile() || info.isSymbolicLink()) throw Error('Invalid database file'); } catch(e) { if(e.code !== 'ENOENT') throw e; }
    db = new DatabaseSync(databasePath);
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), fingerprint TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS nonces (nonce TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS nonce_expiry ON nonces(expires);
      CREATE TABLE IF NOT EXISTS releases (id TEXT PRIMARY KEY, signed TEXT NOT NULL, payload TEXT NOT NULL, selector TEXT NOT NULL, sequence INTEGER NOT NULL, path TEXT, bytes INTEGER NOT NULL, expires INTEGER NOT NULL, promoted INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS release_path ON releases(path,promoted);
      CREATE INDEX IF NOT EXISTS release_history ON releases(selector,promoted,sequence DESC);
      CREATE TABLE IF NOT EXISTS heads (selector TEXT PRIMARY KEY, sequence INTEGER NOT NULL, release_id TEXT NOT NULL REFERENCES releases(id));
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, operation TEXT NOT NULL, release_id TEXT NOT NULL REFERENCES releases(id), sequence INTEGER NOT NULL);`);
    const fingerprint = digest(JSON.stringify([trust.appId,trust.environment,trust.backendContract,trust.artifactBaseUrl,trust.keyId,trust.publicJwk.x,trust.publicJwk.y]));
    const prior = db.prepare('SELECT fingerprint FROM settings WHERE id=1').get();
    if (prior && prior.fingerprint !== fingerprint) throw Error('Data directory trust differs from configured trust; do not reuse another app or key state');
    db.prepare('INSERT OR IGNORE INTO settings VALUES(1,?)').run(fingerprint);
    const pathFor = path => join(files,digest(path));
    const transaction = fn => { db.exec('BEGIN IMMEDIATE'); try { const value = fn(); db.exec('COMMIT'); return value; } catch(error) { db.exec('ROLLBACK'); throw error; } };
    const head = selector => db.prepare('SELECT h.sequence,r.signed AS manifest FROM heads h JOIN releases r ON r.id=h.release_id WHERE h.selector=?').get(selectorKey(selector)) ?? {sequence:0,manifest:null};
    async function inspect(artifact) {
      let file;
      try {
        file = await open(pathFor(artifact.path),constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const stat = await file.stat(); if (!stat.isFile() || stat.size !== artifact.bytes) return false;
        const hash = createHash('sha256'); for await (const chunk of file.createReadStream({autoClose:false})) hash.update(chunk);
        return hash.digest('hex') === artifact.sha256;
      } catch(error) { if (['ENOENT','ELOOP'].includes(error.code)) return false; throw error; }
      finally { await file?.close(); }
    }
    function addRelease(signed, m) {
      if (db.prepare('SELECT count(*) AS n FROM releases').get().n >= cap.maxReleases) fail(503,'RELEASE_CAPACITY');
      const path = m.artifact?.path ?? null;
      if (path && !db.prepare('SELECT 1 FROM releases WHERE path=?').get(path)) {
        const used = db.prepare('SELECT coalesce(sum(bytes),0) AS n FROM (SELECT path,max(bytes) bytes FROM releases WHERE path IS NOT NULL GROUP BY path)').get().n;
        if (used + m.artifact.bytes > cap.maxStorageBytes) fail(503,'STORAGE_CAPACITY');
      }
      db.prepare('INSERT INTO releases(id,signed,payload,selector,sequence,path,bytes,expires) VALUES(?,?,?,?,?,?,?,?)').run(m.releaseId,signed,JSON.stringify(m),selectorKey(m),m.sequence,path,m.artifact?.bytes ?? 0,Date.now()+7200000);
    }
    function capability(artifact) {
      const encoded = Buffer.from(JSON.stringify({path:artifact.path,sha256:artifact.sha256,bytes:artifact.bytes,exp:Date.now()+900000})).toString('base64url');
      return encoded+'.'+createHmac('sha256',secret).update(encoded).digest('base64url');
    }
    function unpackCapability(token) {
      if (typeof token !== 'string' || token.length > 1024 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) fail(403,'UPLOAD_DENIED');
      const [encoded,signature] = token.split('.'), actual = Buffer.from(signature,'base64url'), expected = createHmac('sha256',secret).update(encoded).digest();
      if (actual.length !== expected.length || !timingSafeEqual(actual,expected)) fail(403,'UPLOAD_DENIED');
      let a; try { a=JSON.parse(Buffer.from(encoded,'base64url')); } catch { fail(403,'UPLOAD_DENIED'); }
      if (!Number.isSafeInteger(a.exp) || a.exp <= Date.now()) fail(403,'UPLOAD_EXPIRED');
      const reserved = db.prepare('SELECT payload FROM releases WHERE path=? AND expires>? LIMIT 1').get(a.path,Date.now());
      if (!reserved) fail(403,'UPLOAD_DENIED');
      const artifact = JSON.parse(reserved.payload).artifact;
      if (a.sha256 !== artifact.sha256 || a.bytes !== artifact.bytes) fail(403,'UPLOAD_DENIED');
      return artifact;
    }
    let active = 0, uploads = 0;
    const requestBudget = rateGate(cap.requestsPerMinute), publishBudget = rateGate(cap.publishPerMinute);
    const server = http.createServer(async(req,res)=>{
      let admitted = false;
      try {
        if (!requestBudget() || active >= cap.concurrentRequests) fail(429,'RATE_LIMITED');
        active++; admitted = true;
        const url = new URL(req.url,'http://localhost');
        if (req.method === 'OPTIONS') { res.writeHead(204,cors); res.end(); return; }
        if (url.pathname.startsWith('/artifacts/') && ['GET','HEAD'].includes(req.method)) {
          const path = url.pathname.slice(11);
          if (url.search || !/^(ios|android)\/[0-9a-f]{64}\/[0-9a-f-]{36}\/[0-9a-f]{64}\.zip$/.test(path)) fail(404,'NOT_FOUND');
          const row = db.prepare('SELECT payload FROM releases WHERE path=? AND promoted=1 LIMIT 1').get(path); if (!row) fail(404,'NOT_FOUND');
          const a = JSON.parse(row.payload).artifact;
          const handle = await open(pathFor(path),constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
          try {
            const stat = await handle.stat(); if (!stat.isFile() || stat.size !== a.bytes) fail(503,'ARTIFACT_UNAVAILABLE');
            const etag = '"'+a.sha256+'"'; let start=0,end=a.bytes-1,status=200;
            if (req.headers.range && (!req.headers['if-range'] || req.headers['if-range'] === etag)) {
              const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
              if (!range || (!range[1] && !range[2])) { res.setHeader('Content-Range',`bytes */${a.bytes}`); fail(416,'INVALID_RANGE'); }
              if (!range[1]) { const suffix=Number(range[2]); if (!Number.isSafeInteger(suffix) || suffix <= 0) fail(416,'INVALID_RANGE'); start=Math.max(0,a.bytes-suffix); }
              else { start=Number(range[1]); end=range[2]?Math.min(Number(range[2]),end):end; }
              if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start>end || start>=a.bytes) { res.setHeader('Content-Range',`bytes */${a.bytes}`); fail(416,'INVALID_RANGE'); }
              status=206;
            }
            res.writeHead(status,{...cors,'Content-Type':'application/zip','Content-Length':String(end-start+1),'Cache-Control':'public, max-age=31536000, immutable','ETag':etag,'Accept-Ranges':'bytes','X-Content-Type-Options':'nosniff',...(status===206?{'Content-Range':`bytes ${start}-${end}/${a.bytes}`}:{})});
            if(req.method==='HEAD') res.end(); else await pipeline(handle.createReadStream({start,end,autoClose:false}),res);
          } finally { await handle.close(); }
          return;
        }
        if (url.pathname === '/upload' && req.method === 'PUT') {
          if (!publisherEnabled) fail(403,'PUBLISHER_DISABLED');
          if (uploads >= cap.concurrentUploads) fail(429,'UPLOAD_BUSY');
          const artifact = unpackCapability(url.searchParams.get('token'));
          uploads++; const temp = join(staging,randomUUID()+'.part'); let handle;
          try {
            if (req.headers['content-length'] !== undefined && Number(req.headers['content-length']) !== artifact.bytes) fail(400,'ARTIFACT_SIZE');
            handle=await open(temp,'wx',0o600); const hash=createHash('sha256'); let bytes=0;
            for await(const chunk of req) { bytes+=chunk.length; if(bytes>artifact.bytes) fail(413,'ARTIFACT_SIZE'); hash.update(chunk); await handle.writeFile(chunk); }
            if(bytes!==artifact.bytes || hash.digest('hex')!==artifact.sha256) fail(400,'ARTIFACT_INTEGRITY');
            await handle.sync(); await handle.close(); handle=null;
            try { await link(temp,pathFor(artifact.path)); } catch(error) { if(error.code==='EEXIST') fail(409,'ARTIFACT_EXISTS'); throw error; }
            const directory=await open(files,'r'); try { await directory.sync(); } finally { await directory.close(); }
            json(res,201,{uploaded:true});
          } finally { await handle?.close(); await unlink(temp).catch(()=>{}); uploads--; }
          return;
        }
        if(req.method!=='POST' || url.search || !['/check','/publish'].includes(url.pathname)) fail(404,'NOT_FOUND');
        if(url.pathname==='/check') {
          let selected; try { selected=validateSelector(await requestJson(req,512)); } catch(error) { if(error instanceof Failure) throw error; fail(400,'INVALID_REQUEST'); }
          json(res,200,{manifest:publisherEnabled?head(selected).manifest:null}); return;
        }
        if(!publishBudget()) fail(429,'RATE_LIMITED');
        if(!publisherEnabled) fail(403,'PUBLISHER_DISABLED');
        const envelope=await requestJson(req,24576); let command;
        try { exactKeys(object(envelope),['command']); command=await verifyPublishCommand(envelope.command,trust); } catch { fail(401,'INVALID_SIGNATURE'); }
        // Consume a verified nonce before asynchronous artifact I/O; failed operations cannot replay it.
        transaction(()=>{
          db.prepare('DELETE FROM nonces WHERE nonce IN (SELECT nonce FROM nonces WHERE expires<? LIMIT 1000)').run(Date.now()-3600000);
          try { db.prepare('INSERT INTO nonces VALUES(?,?)').run(command.nonce,command.exp*1000); } catch(error) { if(error.code==='ERR_SQLITE_ERROR' && error.message.includes('UNIQUE')) fail(409,'REPLAY'); throw error; }
        });
        if(command.action==='status') { let selected; try {selected=validateSelector(command.body);} catch {fail(400,'INVALID_REQUEST');} json(res,200,head(selected)); return; }
        if(command.action==='history') {
          let query;try{query=validateHistoryRequest(command.body);}catch{fail(400,'INVALID_REQUEST');}
          const rows=db.prepare('SELECT payload FROM releases WHERE selector=? AND promoted=1 AND sequence<? ORDER BY sequence DESC LIMIT ?')
            .all(selectorKey(query),query.beforeSequence??Number.MAX_SAFE_INTEGER,query.limit+1);
          const items=rows.slice(0,query.limit).map(row=>historyItem(JSON.parse(row.payload)));
          json(res,200,{items,nextCursor:rows.length>query.limit?items.at(-1).sequence:null,scope:'remote'});return;
        }
        if(command.action==='inspect') {
          let id;try{exactKeys(command.body,['releaseId']);id=command.body.releaseId;if(typeof id!=='string'||!OTA_UUID.test(id))throw Error();}catch{fail(400,'INVALID_REQUEST');}
          const row=db.prepare('SELECT payload FROM releases WHERE id=? AND promoted=1').get(id);
          if(!row)fail(404,'NOT_FOUND');json(res,200,historyItem(JSON.parse(row.payload)));return;
        }
        let m;
        try { exactKeys(command.body,command.action==='reserve'?['manifest']:['manifest','expectedSequence']); m=await verifyManifest(command.body.manifest,trust); } catch {fail(400,'INVALID_MANIFEST');}
        const signed=command.body.manifest;
        if(command.action==='reserve') {
          if(m.action!=='release') fail(400,'NO_ARTIFACT');
          const a=m.artifact, known=db.prepare('SELECT signed FROM releases WHERE id=?').get(m.releaseId);
          if(known && known.signed!==signed) fail(409,'IMMUTABLE_RELEASE');
          if(a.path.split('/')[2]!==m.releaseId) {
            const previous=db.prepare('SELECT payload FROM releases WHERE path=? AND promoted=1 LIMIT 1').get(a.path);
            if(!previous || JSON.stringify(JSON.parse(previous.payload).artifact)!==JSON.stringify(a) || !await inspect(a)) fail(400,'UNKNOWN_ROLLBACK_ARTIFACT');
          }
          const uploaded=await inspect(a);
          transaction(()=>{
            const current=db.prepare('SELECT signed FROM releases WHERE id=?').get(m.releaseId);
            if(current && current.signed!==signed) fail(409,'IMMUTABLE_RELEASE');
            if(!current) addRelease(signed,m); else db.prepare('UPDATE releases SET expires=? WHERE id=?').run(Date.now()+7200000,m.releaseId);
          });
          json(res,200,{releaseId:m.releaseId,uploadRequired:!uploaded,...(!uploaded?{upload:{url:publicUpload+'?token='+capability(a),method:'PUT',headers:{'Content-Type':'application/zip'}},expiresAt:new Date(Date.now()+900000).toISOString()}:{})}); return;
        }
        const expected=command.body.expectedSequence;
        if(!Number.isSafeInteger(expected) || expected<0 || m.sequence!==expected+1) fail(400,'INVALID_SEQUENCE');
        if(m.action==='release' && !await inspect(m.artifact)) fail(400,'INCOMPLETE_ARTIFACT');
        const result=transaction(()=>{
          let existing=db.prepare('SELECT * FROM releases WHERE id=?').get(m.releaseId);
          if(existing && existing.signed!==signed) fail(409,'IMMUTABLE_RELEASE');
          const current=head(m);
          if(current.manifest===signed) return {sequence:m.sequence,releaseId:m.releaseId};
          if(current.sequence!==expected) fail(409,'SEQUENCE_CONFLICT');
          if(existing?.promoted) fail(409,'RELEASE_ALREADY_PROMOTED');
          if(m.action==='release' && (!existing || existing.expires<=Date.now())) fail(400,'RESERVATION_REQUIRED');
          if(!db.prepare('SELECT 1 FROM heads WHERE selector=?').get(selectorKey(m)) && db.prepare('SELECT count(*) AS n FROM heads').get().n>=cap.maxSelectors) fail(503,'CHANNEL_CAPACITY');
          if(!existing) addRelease(signed,m);
          db.prepare('UPDATE releases SET promoted=1 WHERE id=?').run(m.releaseId);
          db.prepare('INSERT INTO heads VALUES(?,?,?) ON CONFLICT(selector) DO UPDATE SET sequence=excluded.sequence,release_id=excluded.release_id').run(selectorKey(m),m.sequence,m.releaseId);
          db.prepare('INSERT INTO audit(at,operation,release_id,sequence) VALUES(?,?,?,?)').run(Date.now(),m.action,m.releaseId,m.sequence);
          return {sequence:m.sequence,releaseId:m.releaseId};
        });
        json(res,200,result);
      } catch(error) {
        if(res.headersSent) res.destroy(); else json(res,error instanceof Failure?error.status:503,{error:error instanceof Failure?error.message:'OTA_UNAVAILABLE'});
      } finally { if(admitted) active--; }
    });
    server.requestTimeout=120000; server.headersTimeout=15000; server.timeout=120000; server.keepAliveTimeout=5000;
    server.maxConnections=cap.concurrentRequests*2;
    // Complete lock cleanup before close callbacks, including immediate restarts.
    server.once('close',()=>{db.close();try{unlinkSync(join(root,'service.lock'));}catch(error){if(error.code!=='ENOENT')throw error;}});
    return server;
  } catch(error) { db?.close(); await unlink(join(root,'service.lock')).catch(()=>{}); throw error; }
}
