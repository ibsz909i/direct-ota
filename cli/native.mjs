import fs from 'node:fs';
import path from 'node:path';
import crypto, {createPublicKey} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const updaterVersion = '8.51.25';
const marker = '// DIRECT_OTA_PATCH_V1\n';
const ignoredDirectories = new Set(['.git', '.gradle', '.idea', 'build', 'DerivedData', 'Pods', 'node_modules']);
// Web/config copies change on each sync without changing the native binary.
// Keep generated native lockfiles and plugin registrations in the fingerprint:
// their resolved contents are effective native build inputs.
const generatedDirectories = new Set([
  'ios/App/App/public', 'android/app/src/main/assets/public',
]);
const ignoredFiles = new Set([
  'direct-ota.runtime.json', 'direct-ota.capacitor.json',
  'ios/App/App/capacitor.config.json', 'android/app/src/main/assets/capacitor.config.json',
]);
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); }
function requireConfig(config) {
  if (!config || config.schema !== 1 || typeof config.appId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(config.appId) ||
      typeof config.environment !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(config.environment) || !Number.isSafeInteger(config.backendContract) || config.backendContract < 1 || config.backendContract > 2147483647 ||
      typeof config.artifactBaseUrl !== 'string' || typeof config.keyId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(config.keyId) ||
      !config.publicJwk || config.publicJwk.kty !== 'EC' || config.publicJwk.crv !== 'P-256' ||
      typeof config.publicJwk.x !== 'string' || typeof config.publicJwk.y !== 'string' ||
      typeof config.bundlePublicKey !== 'string' || !config.bundlePublicKey) throw Error('Invalid Direct OTA native configuration');
  const url = new URL(config.artifactBaseUrl);
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash ||
      url.href !== config.artifactBaseUrl || config.artifactBaseUrl.endsWith('/') ||
      !/^\/[A-Za-z0-9/_-]*$/.test(url.pathname)) throw Error('Artifact base must be a pinned HTTPS URL without a trailing slash');
  for (const coordinate of [config.publicJwk.x, config.publicJwk.y]) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(coordinate) || Buffer.from(coordinate, 'base64url').length !== 32) throw Error('Invalid P-256 public key coordinates');
  }
  const bundle = createPublicKey(config.bundlePublicKey);
  if (bundle.asymmetricKeyType !== 'rsa' || bundle.asymmetricKeyDetails?.modulusLength !== 2048) throw Error('Bundle key must be RSA-2048');
}

/** Use the host's Capacitor CLI to confirm the plugins it will actually sync. */
export function verifyCapacitorPlugins(projectRoot) {
  const root = path.resolve(projectRoot);
  const pkg = readJson(path.join(root, 'package.json'));
  const declared = {...pkg.dependencies, ...pkg.devDependencies};
  for (const name of ['@capgo/capacitor-updater', '@capacitor/app']) {
    if (!Object.hasOwn(declared, name)) throw Error(`Install ${name} as a direct app dependency before Direct OTA native setup`);
  }
  const hostRequire = createRequire(path.join(root, 'package.json'));
  let configPath, pluginPath;
  try {
    configPath = hostRequire.resolve('@capacitor/cli/dist/config.js');
    pluginPath = hostRequire.resolve('@capacitor/cli/dist/plugin.js');
    const updater = readJson(hostRequire.resolve('@capgo/capacitor-updater/package.json'));
    const app = readJson(hostRequire.resolve('@capacitor/app/package.json'));
    const cli = readJson(hostRequire.resolve('@capacitor/cli/package.json'));
    if (updater.version !== updaterVersion || !/^8\./.test(app.version) || !/^8\./.test(cli.version)) throw Error('Unsupported Capacitor plugin version');
  } catch {
    throw Error('Install Capacitor CLI 8, @capacitor/app 8, and @capgo/capacitor-updater 8.51.25 in the host app');
  }
  const script = `const {loadConfig}=require(process.argv[1]);const {getPlugins}=require(process.argv[2]);
    (async()=>{const c=await loadConfig();const found={};for(const p of ['ios','android'])found[p]=(await getPlugins(c,p)).map(x=>x.id);
    process.stdout.write('DIRECT_OTA_DISCOVERY='+JSON.stringify(found)+'\\n')})().catch(()=>process.exit(2));`;
  const result = spawnSync(process.execPath, ['-e', script, configPath, pluginPath], {
    cwd: root, encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) throw Error('Capacitor CLI plugin discovery failed. Check capacitor.config and installed host plugins.');
  const marker = result.stdout?.split('\n').find(line=>line.startsWith('DIRECT_OTA_DISCOVERY='));
  if (!marker) throw Error('Capacitor CLI plugin discovery did not return a plugin list');
  let found;
  try { found = JSON.parse(marker.slice('DIRECT_OTA_DISCOVERY='.length)); }
  catch { throw Error('Capacitor CLI plugin discovery returned invalid data'); }
  for (const platform of ['ios','android']) {
    for (const name of ['@capgo/capacitor-updater','@capacitor/app']) {
      if (!found[platform]?.includes(name)) throw Error(`${platform} Capacitor plugin discovery excludes ${name}. Check includePlugins in capacitor.config.`);
    }
  }
  return found;
}

/** Check every pinned source and overlay before a guided setup writes an identity. */
function nativeWrites(projectRoot) {
  const base = path.join(projectRoot, 'node_modules', '@capgo', 'capacitor-updater');
  const baseStat = fs.lstatSync(base);
  if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) throw Error('Updater package must be a real directory for native patching');
  const realBase = fs.realpathSync(base);
  const insidePackage = file => fs.realpathSync(file).startsWith(realBase + path.sep);
  const version = readJson(path.join(base, 'package.json')).version;
  if (version !== updaterVersion) throw Error(`Direct OTA requires @capgo/capacitor-updater ${updaterVersion}`);
  const spec = readJson(path.join(packageRoot, 'native', 'patches.json'));
  const writes = [];
  for (const item of spec) {
    const file = path.join(base, item.path);
    const fileStat = fs.lstatSync(file);
    if (!fileStat.isFile() || fileStat.isSymbolicLink() || !insidePackage(file)) throw Error(`Updater source is not a regular package file: ${item.path}`);
    const original = fs.readFileSync(file, 'utf8');
    const currentHash = sha256(original);
    if (currentHash === item.patchedSha256) continue;
    if (currentHash !== item.sha256) throw Error(`Updater source drift: ${item.path}`);
    let patched = original;
    for (const edit of item.edits) {
      if (patched.split(edit.find).length !== 2) throw Error(`Updater patch anchor drift: ${item.path}`);
      patched = patched.replace(edit.find, edit.replace);
    }
    patched = marker + patched;
    if (sha256(patched) !== item.patchedSha256) throw Error(`Updater patched hash mismatch: ${item.path}`);
    writes.push([file, patched]);
  }
  const overlay = [
    ['ios/DirectOta.swift', 'ios/Sources/CapacitorUpdaterPlugin/DirectOta.swift'],
    ['ios/DirectOtaProtocol.swift', 'ios/Sources/CapacitorUpdaterPlugin/DirectOtaProtocol.swift'],
    ['android/DirectOta.java', 'android/src/main/java/ee/forgr/capacitor_updater/DirectOta.java'],
    ['android/DirectOtaVersion.java', 'android/src/main/java/ee/forgr/capacitor_updater/DirectOtaVersion.java'],
  ];
  for (const [source, target] of overlay) {
    const bytes = fs.readFileSync(path.join(packageRoot, 'native', source));
    const destination = path.join(base, target);
    if (!insidePackage(path.dirname(destination))) throw Error(`Native overlay path escapes updater package: ${target}`);
    if (fs.existsSync(destination)) {
      const destinationStat = fs.lstatSync(destination);
      if (!destinationStat.isFile() || destinationStat.isSymbolicLink()) throw Error(`Native overlay is not a regular file: ${target}`);
    }
    if (fs.existsSync(destination) && sha256(fs.readFileSync(destination)) !== sha256(bytes)) {
      throw Error(`Native overlay drift: ${target}`);
    }
    writes.push([destination, bytes]);
  }
  return {writes, updaterVersion, patchedFiles: spec.length, overlayFiles: overlay.length};
}

export function verifyNativePatch(projectRoot) {
  const {updaterVersion, patchedFiles, overlayFiles} = nativeWrites(projectRoot);
  return {updaterVersion, patchedFiles, overlayFiles};
}

/** Apply the exact Direct OTA overlay to an installed, pristine Capgo 8.51.25 package. */
export function installNative(projectRoot, config) {
  requireConfig(config);
  const {writes, updaterVersion, patchedFiles, overlayFiles} = nativeWrites(projectRoot);
  for (const [file, content] of writes) fs.writeFileSync(file, content);
  return {updaterVersion, patchedFiles, overlayFiles};
}

/** Hash only declared native compatibility inputs, including path names and file bytes. */
export function fingerprintNative(projectRoot, config) {
  requireConfig(config);
  if (!Array.isArray(config?.runtimeInputs) || config.runtimeInputs.length === 0) throw Error('Missing runtimeInputs');
  const root = path.resolve(projectRoot);
  const files = [];
  const visit = relative => {
    const absolute = path.resolve(root, relative);
    if (absolute !== root && !absolute.startsWith(root + path.sep)) throw Error(`Runtime input escapes project: ${relative}`);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw Error(`Symlink runtime input: ${relative}`);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(absolute).sort()) {
        const child = path.posix.join(relative, entry);
        if (!ignoredDirectories.has(entry) && !generatedDirectories.has(child)) visit(child);
      }
    } else if (stat.isFile() && !ignoredFiles.has(relative)) files.push(relative);
    else if (!stat.isFile()) throw Error(`Unsupported runtime input: ${relative}`);
  };
  for (const input of config.runtimeInputs) {
    if (typeof input !== 'string' || !input || path.isAbsolute(input) || input.includes('\\') || input.split('/').includes('..')) throw Error('Invalid runtime input path');
    visit(input);
  }
  const hash = crypto.createHash('sha256');
  hash.update('direct-ota-runtime-v1\0');
  hash.update(JSON.stringify({
    schema: config.schema,
    appId: config.appId,
    environment: config.environment,
    backendContract: config.backendContract,
    artifactBaseUrl: config.artifactBaseUrl,
    keyId: config.keyId,
    publicJwk: {kty: config.publicJwk.kty, crv: config.publicJwk.crv, x: config.publicJwk.x, y: config.publicJwk.y},
    bundlePublicKey: config.bundlePublicKey,
  }) + '\0');
  for (const relative of ['native/patches.json', 'native/ios/DirectOta.swift', 'native/ios/DirectOtaProtocol.swift', 'native/android/DirectOta.java', 'native/android/DirectOtaVersion.java']) {
    hash.update(relative + '\0');
    hash.update(fs.readFileSync(path.join(packageRoot, relative)));
    hash.update('\0');
  }
  for (const relative of [...new Set(files)].sort()) {
    hash.update(relative + '\0');
    const bytes = fs.readFileSync(path.join(root, relative));
    if (relative === 'capacitor.config.json') {
      // JSON hosts embed the generated plugin object. Its runtime field cannot
      // hash itself; trust and updater settings are pinned separately and doctor
      // compares the effective native copies. Keep every other config field.
      const parsed = JSON.parse(bytes.toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error('Invalid capacitor.config.json');
      const normalized = structuredClone(parsed);
      if (normalized.plugins && typeof normalized.plugins === 'object' && !Array.isArray(normalized.plugins)) {
        delete normalized.plugins.CapacitorUpdater;
        if (!Object.keys(normalized.plugins).length) delete normalized.plugins;
      }
      hash.update(JSON.stringify(normalized));
    } else hash.update(bytes);
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** Pure effective plugin configuration for doctor checks and native generation. */
export function nativePluginConfig(config, runtime, channel = 'production') {
  requireConfig(config);
  if (!['internal', 'production'].includes(channel)) throw Error('Invalid Direct OTA channel');
  if (typeof runtime !== 'string' || !/^[0-9a-f]{64}$/.test(runtime)) throw Error('Invalid Direct OTA runtime');
  return {
    autoUpdate: 'off', updateUrl: '', statsUrl: '', channelUrl: '',
    allowModifyUrl: false, autoDeletePrevious: false, autoDeleteFailed: false,
    appReadyTimeout: 30000, responseTimeout: 45, resetWhenUpdate: true,
    keepUrlPathAfterReload: true, shakeMenu: false, enableShakeMenu: false,
    // Capgo 8.51.25 decryptors require PKCS#1 PEM; project identity stays SPKI.
    publicKey: createPublicKey(config.bundlePublicKey).export({type: 'pkcs1', format: 'pem'}),
    directOtaAppId: config.appId, directOtaEnvironment: config.environment,
    directOtaArtifactBaseUrl: config.artifactBaseUrl, directOtaBackendContract: config.backendContract,
    directOtaRuntime: runtime, directOtaChannel: channel,
    directOtaKeyId: config.keyId, directOtaKeyX: config.publicJwk.x, directOtaKeyY: config.publicJwk.y,
  };
}

/** Emit generated runtime and Capacitor plugin configuration for the host app to import. */
export function writeNativeConfig(projectRoot, config, {channel = 'production'} = {}) {
  const runtime = fingerprintNative(projectRoot, config);
  const plugin = nativePluginConfig(config, runtime, channel);
  writeJson(path.join(projectRoot, 'direct-ota.runtime.json'), {protocol: 1, runtime});
  writeJson(path.join(projectRoot, 'direct-ota.capacitor.json'), plugin);
  return {runtime, plugin};
}
