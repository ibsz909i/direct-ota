import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';

test('local Supabase Storage enforces OTA writes and serves immutable public bytes', {
  skip: process.env.DIRECT_OTA_LOCAL_STORAGE_TEST !== '1',
}, async () => {
  const workdir = process.env.DIRECT_OTA_SUPABASE_WORKDIR;
  assert.ok(workdir, 'Set DIRECT_OTA_SUPABASE_WORKDIR to a disposable local stack');
  const status = JSON.parse(execFileSync('supabase', ['status', '--workdir', workdir, '--output', 'json'], {
    encoding:'utf8', stdio:['ignore','pipe','pipe'], timeout:15000,
  }));
  const base = status.API_URL, anon = status.ANON_KEY, service = status.SERVICE_ROLE_KEY;
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(anon && service);
  const bytes = Buffer.from('Synthetic Direct OTA Storage integration payload');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const path = `ios/${'a'.repeat(64)}/${randomUUID()}/${hash}.zip`;
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  const objectUrl = `${base}/storage/v1/object/direct-ota/${encoded}`;
  const publicUrl = `${base}/storage/v1/object/public/direct-ota/${encoded}`;
  const headers = key => ({apikey:key, Authorization:`Bearer ${key}`});
  const anonymousWrite = await fetch(objectUrl, {
    method:'POST', headers:{...headers(anon),'Content-Type':'application/zip','x-upsert':'false'}, body:bytes,
  });
  await anonymousWrite.body?.cancel();
  assert.ok([400,401,403].includes(anonymousWrite.status), `anonymous upload returned ${anonymousWrite.status}`);
  const signed = await fetch(`${base}/storage/v1/object/upload/sign/direct-ota/${encoded}`, {
    method:'POST', headers:{...headers(service),'Content-Type':'application/json'}, body:'{}',
  });
  assert.equal(signed.status, 200);
  const capability = await signed.json();
  let uploadUrl;
  if (capability.url?.startsWith('/object/upload/sign/')) uploadUrl = base + '/storage/v1' + capability.url;
  else if (capability.token) uploadUrl = `${base}/storage/v1/object/upload/sign/direct-ota/${encoded}?token=${encodeURIComponent(capability.token)}`;
  else throw Error('Supabase did not return a scoped upload capability');
  assert.equal(new URL(uploadUrl).origin, base);
  try {
    const upload = await fetch(uploadUrl, {
      method:'PUT', headers:{'Content-Type':'application/zip','x-upsert':'false'}, body:bytes,
    });
    await upload.body?.cancel();
    assert.ok([200,201].includes(upload.status), `signed upload returned ${upload.status}`);
    const duplicate = await fetch(uploadUrl, {
      method:'PUT', headers:{'Content-Type':'application/zip','x-upsert':'false'}, body:bytes,
    });
    await duplicate.body?.cancel();
    assert.ok(!duplicate.ok, 'immutable upload was overwritten');
    const publicRead = await fetch(publicUrl, {redirect:'error'});
    assert.equal(publicRead.status, 200);
    assert.deepEqual(Buffer.from(await publicRead.arrayBuffer()), bytes);
    const range = await fetch(publicUrl, {headers:{Range:'bytes=0-3'},redirect:'error'});
    assert.equal(range.status, 206);
    assert.equal(await range.text(), 'Synt');
    const anonymousDelete = await fetch(objectUrl, {method:'DELETE',headers:headers(anon)});
    await anonymousDelete.body?.cancel();
    assert.ok(!anonymousDelete.ok, 'anonymous deletion succeeded');
  } finally {
    const cleanup = await fetch(objectUrl, {method:'DELETE',headers:headers(service)});
    await cleanup.body?.cancel();
    assert.ok(cleanup.ok, `test artifact cleanup returned ${cleanup.status}`);
  }
});
