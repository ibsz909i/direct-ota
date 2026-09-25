import {execFileSync} from 'node:child_process';
import {cp, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {createConnection} from 'node:net';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {exportProvider} from '../cli/provider.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const run = (program, args, options = {}) => execFileSync(program, args, {
  cwd: root, encoding:'utf8', stdio:['ignore','pipe','pipe'], timeout:300000,
  maxBuffer:2 * 1024 * 1024, ...options,
});
function occupied(port) {
  return new Promise(resolvePort => {
    const socket = createConnection({host:'127.0.0.1',port});
    socket.setTimeout(500);
    socket.once('connect', () => { socket.destroy(); resolvePort(true); });
    socket.once('error', () => { socket.destroy(); resolvePort(false); });
    socket.once('timeout', () => { socket.destroy(); resolvePort(false); });
  });
}

const workdir = await mkdtemp(join(tmpdir(),'direct-ota-supabase-'));
let started = false;
try {
  for (let port = 54320; port <= 54329; port++) {
    if (await occupied(port)) throw Error(`Local port ${port} is occupied; stop or reconfigure that service before running this isolated test`);
  }
  run('supabase',['init','--workdir',workdir,'--yes']);
  const exported = join(workdir,'exported');
  await exportProvider('supabase',exported);
  for (const name of ['migrations','functions']) {
    await cp(join(exported,name),join(workdir,'supabase',name),{recursive:true,errorOnExist:true,force:false});
  }
  const configPath = join(workdir,'supabase','config.toml');
  const config = await readFile(configPath,'utf8');
  await writeFile(configPath,config + '\n[functions.direct-ota-check]\nverify_jwt = false\n\n[functions.direct-ota-publish]\nverify_jwt = false\n');
  started = true;
  run('supabase',['start','--workdir',workdir,'--exclude','studio,imgproxy,logflare,vector,mailpit,realtime','--yes']);
  const environment = {...process.env,DIRECT_OTA_LOCAL_STORAGE_TEST:'1',DIRECT_OTA_SUPABASE_WORKDIR:workdir};
  const storage = run('node',['--test','tests/supabase-storage.integration.test.mjs'],{env:environment});
  process.stdout.write(storage);
  const sql = run('node',['--test','tests/supabase-sql.test.mjs'],{env:{
    ...environment,DIRECT_OTA_SQL_TEST:'1',PGHOST:'127.0.0.1',PGPORT:'54322',PGUSER:'postgres',PGPASSWORD:'postgres',
  }});
  process.stdout.write(sql);
} catch (error) {
  process.stderr.write(`Local Supabase acceptance failed: ${error.code ?? error.status ?? 'test failure'}\n`);
  process.exitCode = 1;
} finally {
  if (started) {
    try { run('supabase',['stop','--workdir',workdir,'--no-backup','--yes'],{timeout:120000}); }
    catch { process.stderr.write('Could not stop the isolated local Supabase stack; inspect Docker before retrying.\n'); process.exitCode = 1; }
  }
  if (!process.exitCode) await rm(workdir,{recursive:true,force:true});
  else process.stderr.write(`Local test workspace retained for diagnosis: ${workdir}\n`);
}
