import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {installNative, fingerprintNative, writeNativeConfig} from '../cli/native.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const config={schema:1,appId:'app.example.demo',environment:'test',backendContract:1,
  artifactBaseUrl:'https://example.invalid/artifacts',keyId:'synthetic-key',
  publicJwk:{kty:'EC',crv:'P-256',x:Buffer.alloc(32,1).toString('base64url'),y:Buffer.alloc(32,2).toString('base64url')},
  bundlePublicKey:crypto.generateKeyPairSync('rsa',{modulusLength:2048}).publicKey.export({type:'spki',format:'pem'}),runtimeInputs:['capacitor.config.ts','package-lock.json','ios','android']};
const digest=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('native overlay checks pinned upstream, applies exact hashes and is idempotent', t=>{
  const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'direct-ota-native-'));
  t.after(()=>fs.rmSync(fixture,{recursive:true,force:true}));
  const source=path.join(root,'node_modules/@capgo/capacitor-updater');
  const target=path.join(fixture,'node_modules/@capgo/capacitor-updater');
  fs.mkdirSync(path.dirname(target),{recursive:true});fs.cpSync(source,target,{recursive:true});
  const result=installNative(fixture,config);
  assert.equal(result.patchedFiles,4);assert.equal(result.overlayFiles,3);
  const patches=JSON.parse(fs.readFileSync(path.join(root,'native/patches.json')));
  for(const patch of patches)assert.equal(digest(path.join(target,patch.path)),patch.patchedSha256);
  assert.doesNotThrow(()=>installNative(fixture,config));
  const drift=path.join(target,patches[0].path);fs.appendFileSync(drift,'\n// drift\n');
  assert.throws(()=>installNative(fixture,config),/Updater source drift/);
});

test('fingerprint tracks declared native bytes while generated files stay stable', t=>{
  const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'direct-ota-runtime-'));
  t.after(()=>fs.rmSync(fixture,{recursive:true,force:true}));
  fs.mkdirSync(path.join(fixture,'ios'),{recursive:true});fs.mkdirSync(path.join(fixture,'android'),{recursive:true});
  fs.writeFileSync(path.join(fixture,'capacitor.config.ts'),'export default {}');
  fs.writeFileSync(path.join(fixture,'package-lock.json'),'{}');
  fs.writeFileSync(path.join(fixture,'ios','App.swift'),'synthetic');
  fs.writeFileSync(path.join(fixture,'android','Main.java'),'synthetic');
  const first=fingerprintNative(fixture,config);
  assert.match(first,/^[0-9a-f]{64}$/);
  const generated=writeNativeConfig(fixture,config,{channel:'internal'});
  assert.equal(generated.runtime,first);
  assert.equal(generated.plugin.directOtaAppId,'app.example.demo');
  assert.equal(generated.plugin.directOtaChannel,'internal');
  assert.equal(fingerprintNative(fixture,config),first);
  assert.notEqual(fingerprintNative(fixture,{...config,environment:'staging'}),first);
  writeNativeConfig(fixture,config,{channel:'production'});
  assert.equal(fingerprintNative(fixture,config),first);
  fs.mkdirSync(path.join(fixture,'ios/App/App/public'),{recursive:true});
  fs.mkdirSync(path.join(fixture,'android/app/src/main/assets/public'),{recursive:true});
  fs.writeFileSync(path.join(fixture,'ios/App/App/public/index.html'),'generated web');
  fs.writeFileSync(path.join(fixture,'android/app/src/main/assets/public/index.html'),'generated web');
  assert.equal(fingerprintNative(fixture,config),first);
  fs.writeFileSync(path.join(fixture,'android/capacitor.settings.gradle'),'generated plugin registry');
  assert.notEqual(fingerprintNative(fixture,config),first);
  const withRegistration=fingerprintNative(fixture,config);
  fs.mkdirSync(path.join(fixture,'ios/App/App/Assets.xcassets'),{recursive:true});
  fs.writeFileSync(path.join(fixture,'ios/App/App/Assets.xcassets/icon.png'),'native resource');
  assert.notEqual(fingerprintNative(fixture,config),withRegistration);
  const withResource=fingerprintNative(fixture,config);
  fs.writeFileSync(path.join(fixture,'android','Main.java'),'changed');
  assert.notEqual(fingerprintNative(fixture,config),withResource);
  assert.throws(()=>writeNativeConfig(fixture,{...config,artifactBaseUrl:'http://example.invalid/artifacts'}),/HTTPS/);
});

test('Swift protocol verifies synthetic signatures and rejects drift',t=>{
  if(process.platform!=='darwin'||spawnSync('swiftc',['--version']).status!==0){t.skip('Swift CryptoKit compiler unavailable');return;}
  const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'direct-ota-swift-'));
  t.after(()=>fs.rmSync(fixture,{recursive:true,force:true}));
  const executable=path.join(fixture,'protocol-test');
  execFileSync('swiftc',[path.join(root,'native/ios/DirectOtaProtocol.swift'),path.join(root,'native/tests/main.swift'),'-o',executable],{stdio:'pipe'});
  assert.match(execFileSync(executable,{encoding:'utf8'}),/signature, compatibility, archive path and range tests passed/);
});
