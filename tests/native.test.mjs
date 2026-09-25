import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {installNative, fingerprintNative, writeNativeConfig, nativePluginConfig} from '../cli/native.mjs';
import {initProject, readIdentity} from '../cli/config.mjs';
import {encryptBundle} from '../cli/crypto.mjs';
import {validateManifest} from '../dist/protocol.js';

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
  assert.equal(result.patchedFiles,4);assert.equal(result.overlayFiles,4);
  const patches=JSON.parse(fs.readFileSync(path.join(root,'native/patches.json')));
  for(const patch of patches)assert.equal(digest(path.join(target,patch.path)),patch.patchedSha256);
  assert.doesNotThrow(()=>installNative(fixture,config));
  const drift=path.join(target,patches[0].path);fs.appendFileSync(drift,'\n// drift\n');
  assert.throws(()=>installNative(fixture,config),/Updater source drift/);
  const outside=path.join(fixture,'outside.swift');fs.writeFileSync(outside,'outside package');
  fs.rmSync(drift);fs.symlinkSync(outside,drift);
  assert.throws(()=>installNative(fixture,config),/regular package file/);
  assert.equal(fs.readFileSync(outside,'utf8'),'outside package');
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
  assert.equal(generated.plugin.directOtaMaxArchiveBytes,5242880);
  const larger={...config,limits:{archiveBytes:20971520,unpackedBytes:104857600,files:5000}};
  assert.equal(nativePluginConfig(larger,first,'internal').directOtaMaxArchiveBytes,20971520);
  assert.notEqual(fingerprintNative(fixture,larger),first);
  const next=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const nextKey={keyId:'synthetic-next',publicJwk:next.publicKey.export({format:'jwk'})};
  const ring=[{keyId:config.keyId,publicJwk:config.publicJwk},nextKey];
  const pinned={...config,trustedKeys:ring};
  const rotated={...pinned,keyId:nextKey.keyId,publicJwk:nextKey.publicJwk};
  const pinnedRuntime=fingerprintNative(fixture,pinned);
  assert.notEqual(pinnedRuntime,first);
  assert.equal(fingerprintNative(fixture,rotated),pinnedRuntime);
  assert.deepEqual(nativePluginConfig(rotated,pinnedRuntime),nativePluginConfig(pinned,pinnedRuntime));
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

test('JSON Capacitor config can embed generated updater settings without a runtime loop', t=>{
  const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'direct-ota-json-runtime-'));
  t.after(()=>fs.rmSync(fixture,{recursive:true,force:true}));
  fs.mkdirSync(path.join(fixture,'ios'));
  fs.writeFileSync(path.join(fixture,'package-lock.json'),'{}');
  const file=path.join(fixture,'capacitor.config.json');
  const app={appId:'app.example.demo',appName:'Demo',webDir:'www'};
  fs.writeFileSync(file,JSON.stringify(app));
  const hostConfig={...config,runtimeInputs:['capacitor.config.json','package-lock.json','ios']};
  const before=fingerprintNative(fixture,hostConfig);
  const generated=writeNativeConfig(fixture,hostConfig,{channel:'internal'});
  fs.writeFileSync(file,JSON.stringify({...app,plugins:{CapacitorUpdater:generated.plugin}}));
  assert.equal(fingerprintNative(fixture,hostConfig),before);
  fs.writeFileSync(file,JSON.stringify({...app,appName:'Changed',plugins:{CapacitorUpdater:generated.plugin}}));
  assert.notEqual(fingerprintNative(fixture,hostConfig),before);
});

test('Swift protocol verifies synthetic signatures and rejects drift',t=>{
  if(process.platform!=='darwin'||spawnSync('swiftc',['--version']).status!==0){t.skip('Swift CryptoKit compiler unavailable');return;}
  const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'direct-ota-swift-'));
  t.after(()=>fs.rmSync(fixture,{recursive:true,force:true}));
  const executable=path.join(fixture,'protocol-test');
  execFileSync('swiftc',[path.join(root,'native/ios/DirectOtaProtocol.swift'),path.join(root,'native/tests/main.swift'),'-o',executable],{stdio:'pipe'});
  assert.match(execFileSync(executable,[path.join(root,'native/tests/semver.txt')],{encoding:'utf8'}),/signature, compatibility, archive path and range tests passed/);
});

test('Android version validator matches the shared SemVer corpus',t=>{
  if(spawnSync('javac',['-version']).status!==0){t.skip('Java compiler unavailable');return;}
  const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'direct-ota-java-'));
  t.after(()=>fs.rmSync(fixture,{recursive:true,force:true}));
  execFileSync('javac',['-d',fixture,path.join(root,'native/android/DirectOtaVersion.java'),path.join(root,'native/tests/VersionCorpus.java')],{stdio:'pipe'});
  assert.match(execFileSync('java',['-cp',fixture,'ee.forgr.capacitor_updater.VersionCorpus',path.join(root,'native/tests/semver.txt')],{encoding:'utf8'}),/15 cases passed/);
});

test('public protocol matches the native SemVer corpus',()=>{
  const trust={appId:'app.example.demo',environment:'test',artifactBaseUrl:'https://example.invalid/artifacts',
    keyId:'synthetic-key',publicJwk:crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'}).publicKey.export({format:'jwk'}),backendContract:1};
  const manifest={protocol:1,appId:trust.appId,environment:trust.environment,platform:'ios',channel:'production',
    runtime:'a'.repeat(64),sequence:1,backendContract:1,rollout:100,action:'withdraw',
    releaseId:'00000000-0000-4000-8000-000000000001',version:'1.2.3',issuedAt:new Date().toISOString()};
  const corpus=fs.readFileSync(path.join(root,'native/tests/semver.txt'),'utf8').trim().split('\n');
  for(const line of corpus){
    const value={...manifest,version:line.slice(1)};
    const accepted=(()=>{try{validateManifest(value,trust);return true;}catch{return false;}})();
    assert.equal(accepted,line.startsWith('+'),`SemVer mismatch: ${line}`);
  }
});

test('default identity emits Capgo PKCS#1 key and decrypts with pinned upstream cipher',async t=>{
  if(process.platform!=='darwin'||spawnSync('swiftc',['--version']).status!==0){t.skip('Swift CryptoKit compiler unavailable');return;}
  const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'direct-ota-capgo-'));
  t.after(()=>fs.rmSync(fixture,{recursive:true,force:true}));
  const publicConfig=await initProject(fixture,{appId:'app.example.demo',baseUrl:'https://example.invalid'});
  const identity=await readIdentity(fixture,publicConfig);
  const plugin=nativePluginConfig(publicConfig,'a'.repeat(64),'internal');
  assert.match(publicConfig.bundlePublicKey,/^-----BEGIN PUBLIC KEY-----/);
  assert.match(plugin.publicKey,/^-----BEGIN RSA PUBLIC KEY-----/);
  assert.equal(crypto.createPublicKey(plugin.publicKey).export({type:'spki',format:'pem'}),publicConfig.bundlePublicKey);
  const upstream=path.join(root,'node_modules/@capgo/capacitor-updater/ios/Sources/CapacitorUpdaterPlugin');
  const executable=path.join(fixture,'capgo-crypto-test');
  execFileSync('swiftc',[
    ...['CryptoCipher.swift','RSA.swift','CapgoRawRsa.swift','AES.swift'].map(file=>path.join(upstream,file)),
    path.join(root,'native/tests/crypto/main.swift'),'-o',executable,
  ],{stdio:'pipe'});
  const plain=Buffer.from('synthetic Direct OTA encrypted payload');
  const expected=crypto.createHash('sha256').update(plain).digest('hex');
  const encrypted=encryptBundle(plain,identity.bundle);
  const encryptedPath=path.join(fixture,'encrypted.bin'),publicPath=path.join(fixture,'native-public.pem');
  fs.writeFileSync(encryptedPath,encrypted.bytes);fs.writeFileSync(publicPath,plugin.publicKey);
  assert.match(execFileSync(executable,[encryptedPath,publicPath,encrypted.checksum,encrypted.sessionKey,expected],{encoding:'utf8'}),/Upstream Capgo checksum and session decryption passed/);
});
