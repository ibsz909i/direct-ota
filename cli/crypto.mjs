import {createCipheriv,createHash,privateEncrypt,constants,randomBytes,sign} from 'node:crypto';
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
