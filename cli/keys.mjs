import {lstat, readFile, writeFile, rename, unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {generateKeyPairSync, randomBytes} from 'node:crypto';
import {CONFIG, readIdentity, validateConfig} from './config.mjs';
import {fingerprintNative} from './native.mjs';
import {verifyNativeProject} from './doctor.mjs';

async function replaceConfig(root, original, next) {
  const file=join(root,CONFIG),stat=await lstat(file);
  if(!stat.isFile()||stat.isSymbolicLink())throw Error('Public configuration must be a regular file');
  const temporary=join(root,`.direct-ota-config-${randomBytes(8).toString('hex')}.tmp`);
  try {
    await writeFile(temporary,JSON.stringify(next,null,2)+'\n',{flag:'wx',mode:stat.mode&0o777});
    const latest=await lstat(file);
    if(latest.ino!==stat.ino||latest.isSymbolicLink()||await readFile(file,'utf8')!==original)
      throw Error('Public configuration changed during key operation; retry after review');
    await rename(temporary,file);
  } finally { await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;}); }
}

/** Stage a future native-pinned signer without changing the active publisher. */
export async function stageSigningKey(root, config) {
  const current=await readIdentity(root,config);
  const pinned=config.trustedKeys??[{keyId:config.keyId,publicJwk:config.publicJwk}];
  if(pinned.length>=4||pinned.at(-1).keyId!==config.keyId)
    throw Error('Activate the last staged key before adding another; at most four keys may be pinned');
  const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const keyId='publisher-'+randomBytes(8).toString('hex');
  const next=validateConfig({...config,trustedKeys:[...pinned,{keyId,publicJwk:pair.publicKey.export({format:'jwk'})}]});
  const file=join(root,'.direct-ota',`identity-${keyId}.json`);
  const original=await readFile(join(root,CONFIG),'utf8');
  let created=false;
  try {
    await writeFile(file,JSON.stringify({keyId,signing:pair.privateKey.export({type:'pkcs8',format:'pem'}),bundle:current.bundle},null,2)+'\n',{flag:'wx',mode:0o600});
    created=true;
    await replaceConfig(root,original,next);
  } catch(error) {
    if(created)await unlink(file);
    throw error;
  }
  return {keyId,identityFile:`.direct-ota/identity-${keyId}.json`};
}

/** Switch publisher only after the staged key ring is synced in native builds. */
export async function activateSigningKey(root, config) {
  const ring=config.trustedKeys;
  if(!ring||ring.length<2)throw Error('Stage and pin a next signing key first');
  const index=ring.findIndex(entry=>entry.keyId===config.keyId);
  if(index<0||index>=ring.length-1)throw Error('No staged signing key remains');
  const next=validateConfig({...config,keyId:ring[index+1].keyId,publicJwk:ring[index+1].publicJwk});
  await readIdentity(root,next);
  let runtime;
  try { runtime=JSON.parse(await readFile(join(root,'direct-ota.runtime.json'),'utf8')); }
  catch(error) { if(error.code==='ENOENT')throw Error('Native runtime does not pin the staged key; run native and verify a store build first'); throw error; }
  if(runtime.protocol!==1||runtime.runtime!==fingerprintNative(root,next))
    throw Error('Native runtime does not pin the staged key; rebuild and verify the store app first');
  await verifyNativeProject(root,next);
  await replaceConfig(root,await readFile(join(root,CONFIG),'utf8'),next);
  return {keyId:next.keyId};
}
