import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sha=path=>fs.readFileSync(path);

test('actual npm tarball exports every provider to new directories only',t=>{
  const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'direct-ota-packed-export-'));
  t.after(()=>fs.rmSync(fixture,{recursive:true,force:true}));
  const metadata=JSON.parse(execFileSync('npm',['pack','--ignore-scripts','--json','--pack-destination',fixture],{cwd:root,encoding:'utf8'}));
  const packed=Array.isArray(metadata)?metadata[0]:metadata['direct-ota'];
  const tarball=path.join(fixture,packed.filename);
  const listing=execFileSync('tar',['-tzf',tarball],{encoding:'utf8'});
  assert.match(listing,/package\/providers\/node\/gitignore\.template/);
  assert.match(listing,/package\/src\/protocol\.ts/);
  assert.doesNotMatch(listing,/package\/providers\/cloudflare\/(?:\.wrangler\/|worker-configuration\.d\.ts|\.dev\.vars)/);
  execFileSync('tar',['-xzf',tarball,'-C',fixture]);
  const cli=path.join(fixture,'package/cli/index.mjs');
  const pkg=JSON.parse(fs.readFileSync(path.join(fixture,'package/package.json'),'utf8'));
  assert.equal(pkg.exports['./provider'],'./dist/provider.js');
  assert.equal(pkg.exports['./telemetry'],'./dist/telemetry.js');
  for(const provider of ['node','supabase','cloudflare','firebase']){
    const out=path.join(fixture,provider+'-export');
    execFileSync(process.execPath,[cli,'export-provider','--provider',provider,'--project',fixture,'--out',out],{stdio:'pipe'});
    assert.ok(fs.statSync(out).isDirectory());
    if(provider==='node'){
      assert.ok(fs.existsSync(path.join(out,'start.mjs')));
      assert.deepEqual(sha(path.join(out,'.gitignore')),sha(path.join(fixture,'package/providers/node/gitignore.template')));
      assert.match(fs.readFileSync(path.join(out,'.gitignore'),'utf8'),/ota-data\//);
    }else{
      const protocol=path.join(out,provider==='cloudflare'?'src/protocol.ts':provider==='firebase'?'functions/src/protocol.ts':'functions/_shared/protocol.ts');
      assert.deepEqual(sha(protocol),sha(path.join(fixture,'package/src/protocol.ts')));
      assert.doesNotMatch(fs.readFileSync(protocol,'utf8'),/export \* from/);
      if(provider==='cloudflare') {
        assert.ok(fs.existsSync(path.join(out,'migrations/0001_initial.sql')));
        assert.deepEqual(sha(path.join(out,'.gitignore')),sha(path.join(fixture,'package/providers/cloudflare/gitignore.template')));
        assert.equal(fs.existsSync(path.join(out,'worker-configuration.d.ts')),false);
        assert.equal(fs.existsSync(path.join(out,'.wrangler')),false);
        execFileSync(path.join(root,'node_modules/.bin/wrangler'),['deploy','--dry-run','--config',path.join(out,'wrangler.jsonc')],
          {cwd:out,stdio:'pipe',timeout:30000});
      }
      if(provider==='firebase') {
        assert.deepEqual(sha(path.join(out,'functions/src/provider.ts')),sha(path.join(fixture,'package/src/provider.ts')));
        assert.deepEqual(sha(path.join(out,'functions/src/telemetry.ts')),sha(path.join(fixture,'package/src/telemetry.ts')));
        assert.equal(fs.existsSync(path.join(out,'functions/node_modules')),false);
        assert.equal(fs.existsSync(path.join(out,'functions/lib')),false);
        assert.ok(fs.existsSync(path.join(out,'firebase.json')));
      }
    }
    assert.throws(()=>execFileSync(process.execPath,[cli,'export-provider','--provider',provider,'--project',fixture,'--out',out],{stdio:'pipe'}),error=>error.status===1);
  }
  const scaffold=path.join(fixture,'custom-scaffold');
  execFileSync(process.execPath,[cli,'create-provider','--name','sample','--project',fixture,'--out',scaffold],{stdio:'pipe'});
  assert.deepEqual(sha(path.join(scaffold,'src/provider.ts')),sha(path.join(fixture,'package/src/provider.ts')));
  assert.match(fs.readFileSync(path.join(scaffold,'AGENTS.md'),'utf8'),/conformance/);
  fs.symlinkSync(path.join(root,'node_modules'),path.join(scaffold,'node_modules'),'dir');
  execFileSync(path.join(root,'node_modules/.bin/tsc'),['--project',path.join(scaffold,'tsconfig.json'),'--noEmit'],{cwd:scaffold,stdio:'pipe'});
  assert.throws(()=>execFileSync(process.execPath,[cli,'create-provider','--name','sample','--project',fixture,'--out',scaffold],{stdio:'pipe'}),error=>error.status===1);
});
