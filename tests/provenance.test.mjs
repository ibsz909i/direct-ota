import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {signProvenance, verifyProvenance} from '../cli/provenance.mjs';

test('release provenance binds a signed manifest, artifact, and source commit',()=>{
  const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const identity={signing:privateKey};
  const config={keyId:'test-key',publicJwk:publicKey.export({format:'jwk'})};
  const manifest={artifact:{sha256:'a'.repeat(64)}};
  const source={commit:'b'.repeat(40),dirty:false};
  const signed=signProvenance('synthetic-manifest',manifest,source,identity,config);
  assert.deepEqual(verifyProvenance(signed,'synthetic-manifest',manifest,config).source,source);
  assert.throws(()=>verifyProvenance(signed,'different-manifest',manifest,config),/provenance/);
  assert.throws(()=>verifyProvenance(signed,'synthetic-manifest',{artifact:{sha256:'c'.repeat(64)}},config),/provenance/);
  const parts=signed.split('.');parts[1]=Buffer.from(JSON.stringify({...JSON.parse(Buffer.from(parts[1],'base64url')),source:{commit:'c'.repeat(40),dirty:false}})).toString('base64url');
  assert.throws(()=>verifyProvenance(parts.join('.'),'synthetic-manifest',manifest,config),/provenance/);
});
