import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';

test('Cloudflare artifact-limit migration preserves promoted releases, heads and audit', async () => {
  const db=new DatabaseSync(':memory:');
  try {
    const base=join(process.cwd(),'providers/cloudflare/migrations');
    db.exec(await readFile(join(base,'0001_initial.sql'),'utf8'));
    db.prepare(`INSERT INTO releases(id,selector,sequence,signed,payload,path,sha256,bytes,expires,promoted)
      VALUES(?,?,?,?,?,?,?,?,?,1)`).run('release-1','ios:internal:runtime',1,'signed','{}','ios/runtime/release-1/file.zip','a'.repeat(64),100,Date.now()+60000);
    db.prepare('INSERT INTO heads(selector,sequence,release_id) VALUES(?,?,?)').run('ios:internal:runtime',1,'release-1');
    const originalAudit=db.prepare('SELECT count(*) AS n FROM audit').get().n;
    db.exec(await readFile(join(base,'0002_telemetry.sql'),'utf8'));
    db.prepare('INSERT INTO event_totals(release_id,event,count) VALUES(?,?,?)').run('release-1','ready',7);
    db.exec(await readFile(join(base,'0003_larger_artifacts.sql'),'utf8'));
    db.exec(await readFile(join(base,'0004_event_metrics.sql'),'utf8'));
    assert.equal(db.prepare('SELECT count(*) AS n FROM audit').get().n,originalAudit);
    assert.equal(db.prepare('SELECT release_id FROM heads').get().release_id,'release-1');
    assert.equal(db.prepare('SELECT bytes FROM releases WHERE id=?').get('release-1').bytes,100);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    assert.deepEqual({...db.prepare('SELECT count,measured,duration_ms FROM event_totals WHERE release_id=?').get('release-1')},
      {count:7,measured:0,duration_ms:0});
    db.prepare(`INSERT INTO releases(id,selector,sequence,signed,payload,path,sha256,bytes,expires)
      VALUES(?,?,?,?,?,?,?,?,?)`).run('release-2','ios:internal:runtime',2,'signed-2','{}','ios/runtime/release-2/file.zip','b'.repeat(64),20*1024*1024,Date.now()+60000);
    assert.throws(()=>db.prepare(`INSERT INTO releases(id,selector,sequence,signed,payload,path,sha256,bytes,expires)
      VALUES(?,?,?,?,?,?,?,?,?)`).run('release-3','ios:internal:runtime',3,'signed-3','{}','ios/runtime/release-3/file.zip','c'.repeat(64),50*1024*1024+1,Date.now()+60000));
  } finally { db.close(); }
});
