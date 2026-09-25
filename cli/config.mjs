import {readFile, mkdir, writeFile, lstat} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {createPublicKey, generateKeyPairSync, randomBytes} from 'node:crypto';
import {validateTrust, effectiveLimits} from '../dist/protocol.js';

export const CONFIG = 'direct-ota.config.json';
export function httpsUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || url.href !== value) throw new Error('Use a canonical HTTPS URL without credentials, query, or fragment');
  return url;
}
function validatePublicJwk(value) {
  const fields = ['kty', 'crv', 'x', 'y', 'alg', 'use', 'key_ops', 'kid', 'ext'];
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(field => !fields.includes(field)) ||
      value.kty !== 'EC' || value.crv !== 'P-256' ||
      [value.x, value.y].some(coordinate => typeof coordinate !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/.test(coordinate) || Buffer.from(coordinate, 'base64url').toString('base64url') !== coordinate) ||
      (value.alg !== undefined && value.alg !== 'ES256') ||
      (value.use !== undefined && value.use !== 'sig') ||
      (value.key_ops !== undefined && (!Array.isArray(value.key_ops) || value.key_ops.length !== 1 || value.key_ops[0] !== 'verify')) ||
      (value.kid !== undefined && (typeof value.kid !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value.kid))) ||
      (value.ext !== undefined && typeof value.ext !== 'boolean')) throw new Error('Manifest key must contain only public P-256 JWK fields');
  try { createPublicKey({key: value, format: 'jwk'}); }
  catch { throw new Error('Manifest key must be a valid public P-256 JWK'); }
}
function validateBundlePublicKey(value) {
  // createPublicKey also accepts private keys. Check the original encoding and
  // compare its public re-encoding so private or trailing material cannot survive.
  const match = typeof value === 'string' && value.length <= 1024 &&
    /^-----BEGIN (PUBLIC KEY|RSA PUBLIC KEY)-----\r?\n[A-Za-z0-9+/=\r\n]+-----END \1-----\r?\n?$/.exec(value);
  if (!match) throw new Error('Bundle key must contain only a public RSA PEM');
  let key;
  try { key = createPublicKey({key: value, format: 'pem'}); }
  catch { throw new Error('Bundle key must be a valid public RSA PEM'); }
  if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength !== 2048) throw new Error('Bundle key must be RSA-2048');
  const canonical = key.export({type: match[1] === 'RSA PUBLIC KEY' ? 'pkcs1' : 'spki', format: 'pem'});
  const normalized = value.replace(/\r\n/g, '\n');
  if (canonical !== (normalized.endsWith('\n') ? normalized : normalized + '\n')) throw new Error('Bundle key must contain only a canonical public RSA PEM');
}
export function validateConfig(config) {
  if (config.schema !== 1) throw new Error('Unsupported configuration schema');
  validatePublicJwk(config.publicJwk);
  validateTrust(config);
  effectiveLimits(config);
  for (const key of ['checkUrl', 'publishUrl', ...(config.eventsUrl ? ['eventsUrl'] : [])]) httpsUrl(config[key]);
  if (!Array.isArray(config.uploadOrigins) || !config.uploadOrigins.length || config.uploadOrigins.some(x => httpsUrl(x + '/').origin !== x)) throw new Error('Specify exact HTTPS upload origins');
  if (typeof config.webDir !== 'string' || !config.webDir || !Array.isArray(config.runtimeInputs) || !config.runtimeInputs.length || config.runtimeInputs.some(x => typeof x !== 'string' || !x)) throw new Error('Configure webDir and runtimeInputs');
  validateBundlePublicKey(config.bundlePublicKey);
  if (config.scanner !== undefined) {
    const scanner = config.scanner;
    if (!scanner || typeof scanner !== 'object' || Array.isArray(scanner) ||
        Object.keys(scanner).some(key => !['deny','allowFiles'].includes(key))) throw new Error('Invalid scanner settings');
    for (const key of ['deny','allowFiles']) {
      const values = scanner[key] ?? [];
      if (!Array.isArray(values) || values.length > 20 || values.some(value =>
        typeof value !== 'string' || !value || value.length > 128 || /[\r\n\0]/.test(value))) throw new Error('Invalid scanner settings');
    }
    if ((scanner.deny ?? []).some(value => value.length < 4) ||
        (scanner.allowFiles ?? []).some(value => value.startsWith('/') || value.includes('\\') || value.split('/').some(part => !part || part === '.' || part === '..')))
      throw new Error('Invalid scanner settings');
  }
  for (const field of Object.keys(config)) if (/private|secret|token|password/i.test(field)) throw new Error('Public configuration must not contain secrets');
  return config;
}
export async function readConfig(root) { return validateConfig(JSON.parse(await readFile(join(root, CONFIG), 'utf8'))); }
export async function writeJson(path, value, mode = 0o644) { await writeFile(path, JSON.stringify(value, null, 2) + '\n', {flag: 'wx', mode}); }
export async function initProject(root, {appId, baseUrl, provider = 'node', webDir = 'dist',
  runtimeInputs = ['capacitor.config.ts', 'package-lock.json', 'ios', 'android']}) {
  if (!['node', 'supabase', 'cloudflare', 'firebase'].includes(provider)) throw new Error('Provider must be node, supabase, cloudflare, or firebase');
  httpsUrl(baseUrl + "/");
  if (baseUrl.endsWith('/') || new URL(baseUrl).origin !== baseUrl) throw new Error('Use an exact HTTPS origin without a path or trailing slash');
  const signing = generateKeyPairSync('ec', {namedCurve: 'prime256v1'});
  const bundle = generateKeyPairSync('rsa', {modulusLength: 2048});
  const keyId = 'publisher-' + randomBytes(8).toString('hex');
  const config = validateConfig({schema: 1, appId, environment: 'production', backendContract: 1,
    artifactBaseUrl: baseUrl + (provider === 'supabase' ? '/storage/v1/object/public/direct-ota' : '/artifacts'),
    checkUrl: baseUrl + (provider === 'supabase' ? '/functions/v1/direct-ota-check' : '/check'),
    publishUrl: baseUrl + (provider === 'supabase' ? '/functions/v1/direct-ota-publish' : '/publish'),
    keyId, publicJwk: signing.publicKey.export({format: 'jwk'}),
    bundlePublicKey: bundle.publicKey.export({type: 'spki', format: 'pem'}),
    webDir, runtimeInputs,
    uploadOrigins: [new URL(baseUrl).origin]});
  // All writes are create-only. Never silently replace the identity trusted by installed apps.
  await mkdir(root, {recursive: true});
  for (const p of [join(root, CONFIG), join(root, '.direct-ota', 'identity.json')]) {
    try { await lstat(p); throw new Error('Configuration or identity already exists'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  await mkdir(join(root, '.direct-ota'), {recursive: true, mode: 0o700});
  await writeJson(join(root, '.direct-ota', 'identity.json'), {keyId,
    signing: signing.privateKey.export({type: 'pkcs8', format: 'pem'}),
    bundle: bundle.privateKey.export({type: 'pkcs8', format: 'pem'})}, 0o600);
  await writeJson(join(root, CONFIG), config);
  const ignore = join(root, '.gitignore');
  const {appendFile} = await import('node:fs/promises');
  await appendFile(ignore, '\n# Local Direct OTA identity and unpublished releases\n.direct-ota/\n');
  return config;
}
export async function readIdentity(root, config, filename) {
  const path = resolve(root, filename || '.direct-ota/identity.json');
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error('Identity must be a private regular file (chmod 600)');
  const identity = JSON.parse(await readFile(path, 'utf8'));
  const actual = createPublicKey(identity.signing).export({format: 'jwk'});
  const bundle = createPublicKey(identity.bundle).export({type: 'spki', format: 'pem'});
  if (identity.keyId !== config.keyId || actual.x !== config.publicJwk.x || actual.y !== config.publicJwk.y || bundle !== config.bundlePublicKey) throw new Error('Identity does not match the public configuration');
  return identity;
}
