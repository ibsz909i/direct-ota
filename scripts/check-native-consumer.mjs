#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {initProject} from '../cli/config.mjs';

const root = resolve(import.meta.dirname, '..');
const platforms = process.argv.slice(2);
if (!platforms.length || platforms.some(platform => !['ios', 'android'].includes(platform)) ||
    new Set(platforms).size !== platforms.length)
  throw Error('Usage: node scripts/check-native-consumer.mjs ios [android]');
if (platforms.includes('ios') && process.platform !== 'darwin')
  throw Error('An iOS consumer build requires macOS and Xcode');

const fixture = await mkdtemp(join(tmpdir(), 'direct-ota-native-consumer-'));
const log = (name) => console.log(`[native-consumer] ${name}`);
const run = (name, bin, args, cwd = fixture, timeout = 600000) => {
  log(name);
  const result = spawnSync(bin, args, {cwd, stdio: 'inherit', timeout,
    env: {...process.env, CI: '1'}});
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error(`${name} failed (${result.signal ?? result.status})`);
};

try {
  await mkdir(join(fixture, 'www'));
  await writeFile(join(fixture, 'www/index.html'), '<!doctype html><title>Direct OTA fixture</title><main>synthetic fixture</main>');
  await writeFile(join(fixture, 'package.json'), JSON.stringify({
    name: 'direct-ota-native-consumer', version: '1.0.0', private: true,
  }));
  await writeFile(join(fixture, 'capacitor.config.json'), JSON.stringify({
    appId: 'app.example.directotafixture', appName: 'Direct OTA Fixture', webDir: 'www',
  }));
  run('pack current source', 'npm', ['pack', '--silent', '--ignore-scripts', '--pack-destination', fixture], root);
  const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
  const tarball = join(fixture, `direct-ota-${version}.tgz`);
  run('install packaged consumer', 'npm', ['install', '--no-audit', '--no-fund', '--save-exact',
    tarball, '@capacitor/core@8.4.3', '@capacitor/app@8.1.0', '@capacitor/cli@8.4.3',
    '@capgo/capacitor-updater@8.51.25',
    ...platforms.map(platform => `@capacitor/${platform}@8.4.3`)]);
  for (const platform of platforms)
    run(`create ${platform} app`, 'node', ['node_modules/@capacitor/cli/bin/capacitor', 'add', platform]);
  if (platforms.includes('ios')) run('resolve iOS packages before fingerprinting', 'xcodebuild', [
    '-resolvePackageDependencies', '-project', 'ios/App/App.xcodeproj', '-scheme', 'App', '-quiet']);
  await initProject(fixture, {appId: 'app.example.directotafixture',
    baseUrl: 'https://updates.example.invalid', provider: 'node', webDir: 'www',
    runtimeInputs: ['capacitor.config.json', 'package-lock.json', ...platforms]});
  const cli = 'node_modules/direct-ota/cli/index.mjs';
  for (let attempt = 0; attempt < 3; attempt++) {
    run('apply pinned native overlay', 'node', [cli, 'patch']);
    run('generate native trust', 'node', [cli, 'native', '--channel', 'internal']);
    const host = JSON.parse(await readFile(join(fixture, 'capacitor.config.json'), 'utf8'));
    const updater = JSON.parse(await readFile(join(fixture, 'direct-ota.capacitor.json'), 'utf8'));
    host.plugins = {...host.plugins, CapacitorUpdater: updater};
    await writeFile(join(fixture, 'capacitor.config.json'), JSON.stringify(host, null, 2) + '\n');
    run('sync native projects', 'node', ['node_modules/@capacitor/cli/bin/capacitor', 'sync']);
    const doctor = spawnSync('node', [cli, 'doctor'], {cwd: fixture, encoding: 'utf8',
      timeout: 120000});
    if (doctor.status === 0) break;
    if (attempt === 2) throw Error(`Native doctor did not converge: ${doctor.stdout}\n${doctor.stderr}`);
  }
  if (platforms.includes('ios')) run('compile iOS Simulator app', 'xcodebuild', [
    '-project', 'ios/App/App.xcodeproj', '-scheme', 'App', '-configuration', 'Debug',
    '-sdk', 'iphonesimulator', '-destination', 'generic/platform=iOS Simulator',
    '-derivedDataPath', join(fixture, 'derived-data'), '-quiet',
    'CODE_SIGNING_ALLOWED=NO', 'build'], fixture, 1200000);
  if (platforms.includes('android')) run('compile Android debug app',
    './gradlew', ['--no-daemon', 'assembleDebug'], join(fixture, 'android'), 1200000);
  run('verify final native configuration', 'node', [cli, 'doctor']);
  log(`passed: ${platforms.join(', ')}`);
} finally {
  await rm(fixture, {recursive: true, force: true});
}
