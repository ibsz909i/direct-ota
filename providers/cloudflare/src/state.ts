import {historyItem, type OtaArtifact, type OtaManifest, type OtaSelector, type OtaHistoryRequest} from './protocol.ts';
import {fail} from './security.ts';

export const selectorKey = (s: OtaSelector): string => `${s.platform}:${s.channel}:${s.runtime}`;
type Head = {sequence: number; manifest: string | null};
type Release = {id: string; signed: string; payload: string; path: string | null;
  sha256: string | null; bytes: number; expires: number; promoted: number};

export async function head(db: D1Database, selected: OtaSelector): Promise<Head> {
  return await db.prepare(`SELECT h.sequence, r.signed AS manifest FROM heads h
    JOIN releases r ON r.id = h.release_id WHERE h.selector = ?`)
    .bind(selectorKey(selected)).first<Head>() ?? {sequence: 0, manifest: null};
}

export async function consumeCommand(db: D1Database, nonce: string, exp: number): Promise<void> {
  const minute = Math.floor(Date.now() / 60000);
  const gate = await db.prepare(`UPDATE publisher_window SET minute = ?,
    commands = CASE WHEN minute = ? THEN commands + 1 ELSE 1 END
    WHERE id = 1 AND (minute != ? OR commands < 60)`)
    .bind(minute, minute, minute).run();
  if (gate.meta.changes !== 1) fail(429, 'RATE_LIMITED');
  await db.prepare(`DELETE FROM nonces WHERE nonce IN
    (SELECT nonce FROM nonces WHERE expires < ? ORDER BY expires LIMIT 1000)`)
    .bind(Date.now() - 3600000).run();
  try { await db.prepare('INSERT INTO nonces(nonce, expires) VALUES(?, ?)').bind(nonce, exp * 1000).run(); }
  catch (error) {
    if (String(error).includes('UNIQUE constraint failed: nonces.nonce')) fail(409, 'REPLAY');
    throw error;
  }
}

export async function releaseById(db: D1Database, id: string): Promise<Release | null> {
  return db.prepare('SELECT * FROM releases WHERE id = ?').bind(id).first<Release>();
}
export async function history(db: D1Database, query: OtaHistoryRequest) {
  const rows=await db.prepare(`SELECT payload FROM releases WHERE selector=? AND promoted=1 AND sequence<?
    ORDER BY sequence DESC LIMIT ?`).bind(selectorKey(query),query.beforeSequence??Number.MAX_SAFE_INTEGER,query.limit+1)
    .all<{payload:string}>();
  const items=rows.results.slice(0,query.limit).map(row=>historyItem(JSON.parse(row.payload) as OtaManifest));
  return {items,nextCursor:rows.results.length>query.limit?items.at(-1)!.sequence:null,scope:'remote' as const};
}
export async function inspect(db: D1Database, releaseId: string) {
  const row=await db.prepare('SELECT payload FROM releases WHERE id=? AND promoted=1').bind(releaseId).first<{payload:string}>();
  return row?historyItem(JSON.parse(row.payload) as OtaManifest):null;
}

export async function promotedPath(db: D1Database, path: string): Promise<Release | null> {
  return db.prepare('SELECT * FROM releases WHERE path = ? AND promoted = 1 LIMIT 1').bind(path).first<Release>();
}

function equalArtifact(a: OtaArtifact, b: OtaArtifact): boolean {
  const da=a.delta, db=b.delta;
  const sameDelta=(!da&&!db) || (!!da&&!!db&&
    da.fromSha256===db.fromSha256&&da.baseChecksum===db.baseChecksum&&
    da.fullBytes===db.fullBytes&&da.fullSha256===db.fullSha256&&da.offset===db.offset&&
    da.bytes===db.bytes&&da.sha256===db.sha256&&da.checksum===db.checksum&&da.sessionKey===db.sessionKey);
  return sameDelta && a.path === b.path && a.url === b.url && a.sha256 === b.sha256 &&
    a.bytes === b.bytes && a.unpackedBytes === b.unpackedBytes && a.files === b.files &&
    a.checksum === b.checksum && a.sessionKey === b.sessionKey;
}

export async function reserve(db: D1Database, signed: string, manifest: OtaManifest): Promise<void> {
  if (manifest.action !== 'release') fail(400, 'NO_ARTIFACT');
  const artifact = manifest.artifact;
  if (artifact.path.split('/')[2] !== manifest.releaseId) {
    const previous = await promotedPath(db, artifact.path);
    if (!previous || !equalArtifact(JSON.parse(previous.payload).artifact as OtaArtifact, artifact) ||
        JSON.parse(previous.payload).platform !== manifest.platform ||
        JSON.parse(previous.payload).runtime !== manifest.runtime) fail(400, 'UNKNOWN_ROLLBACK_ARTIFACT');
  }
  const existing = await releaseById(db, manifest.releaseId);
  if (existing?.signed !== undefined && existing.signed !== signed) fail(409, 'IMMUTABLE_RELEASE');
  if (existing) {
    if (!existing.promoted) await db.prepare('UPDATE releases SET expires = ? WHERE id = ? AND signed = ? AND promoted = 0')
      .bind(Date.now() + 7200000, manifest.releaseId, signed).run();
    return;
  }
  try {
    await db.prepare(`INSERT INTO releases(id, selector, sequence, signed, payload, path, sha256, bytes, expires)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`)
      .bind(manifest.releaseId, selectorKey(manifest), manifest.sequence, signed, JSON.stringify(manifest),
        artifact.path, artifact.sha256, artifact.bytes, Date.now() + 7200000).run();
  } catch (error) {
    if (String(error).includes('RELEASE_CAPACITY')) fail(429, 'RELEASE_CAPACITY');
    throw error;
  }
  if ((await releaseById(db, manifest.releaseId))?.signed !== signed) fail(409, 'IMMUTABLE_RELEASE');
}

export async function promote(db: D1Database, signed: string, manifest: OtaManifest,
  expectedSequence: number): Promise<{sequence: number; releaseId: string}> {
  const current = await head(db, manifest);
  if (current.manifest === signed) return {sequence: manifest.sequence, releaseId: manifest.releaseId};
  if (current.sequence !== expectedSequence) fail(409, 'SEQUENCE_CONFLICT');
  if (manifest.action === 'withdraw') {
    try {
      await db.prepare(`INSERT INTO releases(id, selector, sequence, signed, payload, bytes, expires)
        VALUES(?, ?, ?, ?, ?, 0, 0) ON CONFLICT(id) DO NOTHING`)
        .bind(manifest.releaseId, selectorKey(manifest), manifest.sequence, signed, JSON.stringify(manifest)).run();
    } catch (error) {
      if (String(error).includes('RELEASE_CAPACITY')) fail(429, 'RELEASE_CAPACITY');
      throw error;
    }
  }
  const existing = await releaseById(db, manifest.releaseId);
  if (!existing || existing.signed !== signed || existing.promoted ||
      (manifest.action === 'release' && (existing.path !== manifest.artifact.path ||
        existing.sha256 !== manifest.artifact.sha256 || existing.bytes !== manifest.artifact.bytes ||
        existing.expires <= Date.now()))) fail(400, 'RESERVATION_REQUIRED');
  try {
    const updated = await db.prepare(`INSERT INTO heads(selector, sequence, release_id)
      SELECT ?, ?, id FROM releases WHERE id = ? AND signed = ? AND selector = ? AND sequence = ?
        AND promoted = 0 AND (path IS NULL OR expires > ?)
      ON CONFLICT(selector) DO UPDATE SET sequence = excluded.sequence, release_id = excluded.release_id
      WHERE heads.sequence = ? AND excluded.sequence = heads.sequence + 1
      RETURNING sequence`)
      .bind(selectorKey(manifest), manifest.sequence, manifest.releaseId, signed,
        selectorKey(manifest), manifest.sequence, Date.now(), expectedSequence).first<{sequence: number}>();
    if (updated?.sequence !== manifest.sequence) fail(409, 'SEQUENCE_CONFLICT');
  } catch (error) {
    if (String(error).includes('CHANNEL_CAPACITY')) fail(429, 'CHANNEL_CAPACITY');
    if (String(error).includes('SEQUENCE_CONFLICT')) fail(409, 'SEQUENCE_CONFLICT');
    throw error;
  }
  return {sequence: manifest.sequence, releaseId: manifest.releaseId};
}
