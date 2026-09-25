import {createHash, createPublicKey, verify} from 'node:crypto';
import {signJws} from './crypto.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
const decode = value => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw Error('Invalid release provenance');
  const bytes=Buffer.from(value,'base64url');
  if (bytes.toString('base64url')!==value) throw Error('Invalid release provenance');
  return bytes;
};

export function signProvenance(signedManifest, manifest, source, identity, config) {
  return signJws({protocol:1,manifestSha256:hash(signedManifest),artifactSha256:manifest.artifact.sha256,
    source,builtAt:new Date().toISOString()},identity.signing,config.keyId,'DIRECT-OTA-PROVENANCE');
}

export function verifyProvenance(compact, signedManifest, manifest, config) {
  if (typeof compact!=='string' || compact.length>4096) throw Error('Invalid release provenance');
  const parts=compact.split('.');
  if (parts.length!==3) throw Error('Invalid release provenance');
  const header=JSON.parse(decode(parts[0]).toString('utf8'));
  if (!exact(header,['alg','typ','kid']) || header.alg!=='ES256' || header.typ!=='DIRECT-OTA-PROVENANCE' || header.kid!==config.keyId)
    throw Error('Invalid release provenance');
  const signature=decode(parts[2]);
  if (signature.length!==64 || !verify('sha256',Buffer.from(parts[0]+'.'+parts[1]),
    {key:createPublicKey({key:config.publicJwk,format:'jwk'}),dsaEncoding:'ieee-p1363'},signature))
    throw Error('Invalid release provenance');
  const value=JSON.parse(decode(parts[1]).toString('utf8'));
  if (!exact(value,['protocol','manifestSha256','artifactSha256','source','builtAt']) || value.protocol!==1 ||
      value.manifestSha256!==hash(signedManifest) || value.artifactSha256!==manifest.artifact.sha256 ||
      typeof value.builtAt!=='string' || !Number.isFinite(Date.parse(value.builtAt)) ||
      (value.source!==null && (!exact(value.source,['commit','dirty']) ||
        !/^[0-9a-f]{40,64}$/.test(value.source.commit) || typeof value.source.dirty!=='boolean')))
    throw Error('Invalid release provenance');
  return value;
}
