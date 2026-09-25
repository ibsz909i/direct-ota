import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

test('GitHub action publishes through the installed CLI and removes its private identity', async () => {
  const fixture=await mkdtemp(join(tmpdir(),'direct-ota-action-test-'));
  try {
    const app=join(fixture,'app'),bin=join(fixture,'bin'),temp=join(fixture,'temp');
    await Promise.all([mkdir(app),mkdir(bin),mkdir(temp)]);
    const capture=join(fixture,'calls.jsonl');
    await writeFile(join(bin,'npx'),`#!/bin/sh\nnode -e 'require("fs").appendFileSync(process.env.CAPTURE,JSON.stringify({args:process.argv.slice(1),secret:process.env.DIRECT_OTA_IDENTITY_B64})+"\\n")' -- "$@"\n`,{mode:0o755});
    const secret=Buffer.from(JSON.stringify({test:'synthetic-publisher-identity'})).toString('base64');
    const result=spawnSync(process.execPath,['scripts/action-publish.mjs'],{cwd:process.cwd(),encoding:'utf8',env:{...process.env,
      PATH:bin+':'+process.env.PATH,TMPDIR:temp,CAPTURE:capture,GITHUB_WORKSPACE:fixture,DIRECT_OTA_PROJECT:'app',
      DIRECT_OTA_PLATFORM:'ios',DIRECT_OTA_VERSION:'1.2.3',DIRECT_OTA_IDENTITY_B64:secret}});
    assert.equal(result.status,0,result.stderr);
    const calls=(await readFile(capture,'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(calls.length,2);
    assert.ok(calls[0].args.includes('publish'));
    assert.ok(calls[1].args.includes('doctor'));
    assert.equal(calls[0].secret,'');
    assert.equal(calls[1].secret,'');
    assert.ok(!result.stdout.includes(secret));
    assert.deepEqual(await (await import('node:fs/promises')).readdir(temp),[]);
    const escaped=spawnSync(process.execPath,['scripts/action-publish.mjs'],{cwd:process.cwd(),encoding:'utf8',env:{...process.env,
      PATH:bin+':'+process.env.PATH,GITHUB_WORKSPACE:app,DIRECT_OTA_PROJECT:'..',DIRECT_OTA_PLATFORM:'ios',DIRECT_OTA_VERSION:'1.2.3',DIRECT_OTA_IDENTITY_B64:secret}});
    assert.notEqual(escaped.status,0);
  } finally { await rm(fixture,{recursive:true,force:true}); }
});
