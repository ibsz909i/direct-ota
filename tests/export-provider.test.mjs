import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sha=path=>fs.readFileSync(path);

test('actual npm tarball exports both providers to new directories only',t=>{
  const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'direct-ota-packed-export-'));
  t.after(()=>fs.rmSync(fixture,{recursive:true,force:true}));
  const metadata=JSON.parse(execFileSync('npm',['pack','--ignore-scripts','--json','--pack-destination',fixture],{cwd:root,encoding:'utf8'}));
  const packed=Array.isArray(metadata)?metadata[0]:metadata['direct-ota'];
  const tarball=path.join(fixture,packed.filename);
  const listing=execFileSync('tar',['-tzf',tarball],{encoding:'utf8'});
  assert.match(listing,/package\/providers\/node\/gitignore\.template/);
  assert.match(listing,/package\/src\/protocol\.ts/);
  execFileSync('tar',['-xzf',tarball,'-C',fixture]);
  const cli=path.join(fixture,'package/cli/index.mjs');
  for(const provider of ['node','supabase']){
    const out=path.join(fixture,provider+'-export');
    execFileSync(process.execPath,[cli,'export-provider','--provider',provider,'--project',fixture,'--out',out],{stdio:'pipe'});
    assert.ok(fs.statSync(out).isDirectory());
    if(provider==='node'){
      assert.ok(fs.existsSync(path.join(out,'start.mjs')));
      assert.deepEqual(sha(path.join(out,'.gitignore')),sha(path.join(fixture,'package/providers/node/gitignore.template')));
      assert.match(fs.readFileSync(path.join(out,'.gitignore'),'utf8'),/ota-data\//);
    }else{
      const protocol=path.join(out,'functions/_shared/protocol.ts');
      assert.deepEqual(sha(protocol),sha(path.join(fixture,'package/src/protocol.ts')));
      assert.doesNotMatch(fs.readFileSync(protocol,'utf8'),/export \* from/);
    }
    assert.throws(()=>execFileSync(process.execPath,[cli,'export-provider','--provider',provider,'--project',fixture,'--out',out],{stdio:'pipe'}),error=>error.status===1);
  }
});
