import {createCipheriv,createDecipheriv,createHash,createPublicKey,privateEncrypt,publicDecrypt,constants,randomBytes,sign} from 'node:crypto';
export function signJws(payload,privateKey,keyId,type='DIRECT-OTA'){
  const head=Buffer.from(JSON.stringify({alg:'ES256',typ:type,kid:keyId})).toString('base64url');
  const body=Buffer.from(JSON.stringify(payload)).toString('base64url');
  const input=head+'.'+body;
  return input+'.'+sign('sha256',Buffer.from(input),{key:privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');
}
export function encryptBundle(zip,privateKey){
  const aes=randomBytes(16),iv=randomBytes(16),cipher=createCipheriv('aes-128-cbc',aes,iv);
  const bytes=Buffer.concat([cipher.update(zip),cipher.final()]);
  const wrap=value=>privateEncrypt({key:privateKey,padding:constants.RSA_PKCS1_PADDING},value);
  return {bytes,sha256:createHash('sha256').update(bytes).digest('hex'),checksum:wrap(createHash('sha256').update(zip).digest()).toString('hex'),sessionKey:iv.toString('base64')+':'+wrap(aes).toString('base64')};
}
/** Inspect a locally signed candidate while preparing a delta. Never log plaintext. */
export function decryptBundle(bytes,artifact,privateKey){
  const digest=value=>createHash('sha256').update(value).digest();
  if(!digest(bytes).equals(Buffer.from(artifact.sha256,'hex')))throw Error('Encrypted bundle digest mismatch');
  const parts=artifact.sessionKey.split(':');
  if(parts.length!==2)throw Error('Invalid bundle envelope');
  const key=createPublicKey(privateKey);
  const unwrap=value=>publicDecrypt({key,padding:constants.RSA_PKCS1_PADDING},value);
  const aes=unwrap(Buffer.from(parts[1],'base64'));
  const expected=unwrap(Buffer.from(artifact.checksum,/^[0-9a-f]{512}$/.test(artifact.checksum)?'hex':'base64'));
  if(aes.length!==16||expected.length!==32)throw Error('Invalid bundle envelope');
  const decipher=createDecipheriv('aes-128-cbc',aes,Buffer.from(parts[0],'base64'));
  const plain=Buffer.concat([decipher.update(bytes),decipher.final()]);
  if(!digest(plain).equals(expected))throw Error('Decrypted bundle digest mismatch');
  return plain;
}
