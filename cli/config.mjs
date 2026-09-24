import {readFile, mkdir, writeFile, lstat} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {createPublicKey, generateKeyPairSync, randomBytes} from 'node:crypto';
import {validateTrust} from '../dist/protocol.js';

export const CONFIG = 'direct-ota.config.json';
export function httpsUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || url.href !== value) throw new Error('Use a canonical HTTPS URL without credentials, query, or fragment');
  return url;
}
export function validateConfig(config) {
  if (config.schema !== 1) throw new Error('Unsupported configuration schema');
  validateTrust(config);
  for (const key of ['checkUrl', 'publishUrl', ...(config.eventsUrl ? ['eventsUrl'] : [])]) httpsUrl(config[key]);
  if (!Array.isArray(config.uploadOrigins) || !config.uploadOrigins.length || config.uploadOrigins.some(x => httpsUrl(x + '/').origin !== x)) throw new Error('Specify exact HTTPS upload origins');
  if (typeof config.webDir !== 'string' || !config.webDir || !Array.isArray(config.runtimeInputs) || !config.runtimeInputs.length || config.runtimeInputs.some(x => typeof x !== 'string' || !x)) throw new Error('Configure webDir and runtimeInputs');
  const key = createPublicKey(config.bundlePublicKey);
  if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength !== 2048) throw new Error('Bundle key must be RSA-2048');
  for (const field of Object.keys(config)) if (/private|secret|token|password/i.test(field)) throw new Error('Public configuration must not contain secrets');
  return config;
}
export async function readConfig(root) { return validateConfig(JSON.parse(await readFile(join(root, CONFIG), 'utf8'))); }
export async function writeJson(path, value, mode = 0o644) { await writeFile(path, JSON.stringify(value, null, 2) + '\n', {flag: 'wx', mode}); }
export async function initProject(root, {appId, baseUrl, provider = 'node'}) {
  if (!['node', 'supabase'].includes(provider)) throw new Error('Provider must be node or supabase');
  httpsUrl(baseUrl + "/");
  if (baseUrl.endsWith('/')) throw new Error('Remove the trailing slash from --base-url');
  const signing = generateKeyPairSync('ec', {namedCurve: 'prime256v1'});
  const bundle = generateKeyPairSync('rsa', {modulusLength: 2048});
  const keyId = 'publisher-' + randomBytes(8).toString('hex');
  const config = validateConfig({schema: 1, appId, environment: 'production', backendContract: 1,
    artifactBaseUrl: baseUrl + (provider === 'node' ? '/artifacts' : '/storage/v1/object/public/direct-ota'),
    checkUrl: baseUrl + (provider === 'node' ? '/check' : '/functions/v1/direct-ota-check'),
    publishUrl: baseUrl + (provider === 'node' ? '/publish' : '/functions/v1/direct-ota-publish'),
    keyId, publicJwk: signing.publicKey.export({format: 'jwk'}),
    bundlePublicKey: bundle.publicKey.export({type: 'spki', format: 'pem'}),
    webDir: 'dist', runtimeInputs: ['capacitor.config.ts', 'package-lock.json', 'ios', 'android'],
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
