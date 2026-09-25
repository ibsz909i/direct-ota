import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {initProject,readConfig,readIdentity} from '../cli/config.mjs';
import {stageSigningKey,activateSigningKey} from '../cli/keys.mjs';

test('key staging preserves the current publisher and keeps the next identity private',async t=>{
 const root=await mkdtemp(join(tmpdir(),'direct-ota-keys-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const original=await initProject(root,{appId:'app.example.demo',baseUrl:'https://updates.example.invalid'});
 const staged=await stageSigningKey(root,original);
 const config=await readConfig(root);
 assert.equal(config.keyId,original.keyId);
 assert.equal(config.trustedKeys.length,2);
 assert.equal(config.trustedKeys[0].keyId,original.keyId);
 assert.equal(config.trustedKeys[1].keyId,staged.keyId);
 assert.equal((await stat(join(root,staged.identityFile))).mode&0o777,0o600);
 assert.ok(!(await readFile(join(root,'direct-ota.config.json'),'utf8')).includes('PRIVATE KEY'));
 const next={...config,keyId:config.trustedKeys[1].keyId,publicJwk:config.trustedKeys[1].publicJwk};
 assert.equal((await readIdentity(root,next)).keyId,staged.keyId);
 await assert.rejects(stageSigningKey(root,config),/Activate the last staged key/);
 await assert.rejects(activateSigningKey(root,config),/Native runtime/);
 assert.equal((await readConfig(root)).keyId,original.keyId);
});
