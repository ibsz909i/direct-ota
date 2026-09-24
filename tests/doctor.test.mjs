import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, writeFile, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {initProject} from '../cli/config.mjs';
import {writeNativeConfig} from '../cli/native.mjs';
import {verifyNativeProject} from '../cli/doctor.mjs';

test('doctor rejects stale native settings even when the recorded runtime matches',async t=>{
 const root=await mkdtemp(join(tmpdir(),'direct-ota-doctor-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const config=await initProject(root,{appId:'app.example.demo',baseUrl:'https://updates.example.invalid'});
 config.runtimeInputs=['native-source.txt'];await writeFile(join(root,'native-source.txt'),'synthetic native source');
 const result=writeNativeConfig(root,config,{channel:'internal'});
 await mkdir(join(root,'ios/App/App'),{recursive:true});
 const nativeFile=join(root,'ios/App/App/capacitor.config.json');
 await writeFile(nativeFile,JSON.stringify({plugins:{CapacitorUpdater:result.plugin}}));
 assert.equal((await verifyNativeProject(root,config)).platforms,1);
 assert.match(result.plugin.publicKey,/BEGIN RSA PUBLIC KEY/);
 await writeFile(nativeFile,JSON.stringify({plugins:{CapacitorUpdater:{...result.plugin,directOtaRuntime:'0'.repeat(64)}}}));
 await assert.rejects(verifyNativeProject(root,config),/stale or inconsistent/);
 await writeFile(nativeFile,JSON.stringify({plugins:{CapacitorUpdater:result.plugin}}));
 const generated=join(root,'direct-ota.capacitor.json');const altered=JSON.parse(await readFile(generated,'utf8'));altered.autoUpdate='always';
 await writeFile(generated,JSON.stringify(altered));await assert.rejects(verifyNativeProject(root,config),/Generated native plugin/);
 await writeFile(generated,JSON.stringify(result.plugin));await writeFile(join(root,'native-source.txt'),'changed native source');
 await assert.rejects(verifyNativeProject(root,config),/runtime drift/);
});
