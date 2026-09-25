import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {randomBytes} from 'node:crypto';
import {initProject, readIdentity} from '../cli/config.mjs';
import {exportProvider} from '../cli/provider.mjs';
import {testProvider} from '../cli/conformance.mjs';
import {command} from '../cli/transport.mjs';

test('Firebase Firestore and Storage emulators pass provider conformance',
  {timeout: 120000, skip: !process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_STORAGE_EMULATOR_HOST}, async t => {
    const root = await mkdtemp(join(tmpdir(), 'direct-ota-firebase-test-'));
    t.after(() => rm(root, {recursive: true, force: true}));
    const config = await initProject(root, {appId: 'app.example.firebaseconformance',
      baseUrl: 'https://direct-ota-test.web.app', provider: 'firebase'});
    const identity = await readIdentity(root, config);
    const serviceDir = join(root, 'ota-service');
    await exportProvider('firebase', serviceDir);
    const functions = join(serviceDir, 'functions');
    await symlink(resolve('providers/firebase/functions/node_modules'), join(functions, 'node_modules'), 'dir');
    execFileSync(resolve('providers/firebase/functions/node_modules/.bin/tsc'), ['--project', join(functions, 'tsconfig.json')],
      {cwd: functions, stdio: 'pipe', timeout: 30000});
    const {createFirebaseProvider} = await import(pathToFileURL(join(functions, 'lib/state.js')).href);
    const requireFunctions = createRequire(join(functions, 'package.json'));
    const {initializeApp, deleteApp} = requireFunctions('firebase-admin/app');
    const {getFirestore} = requireFunctions('firebase-admin/firestore');
    const {getStorage} = requireFunctions('firebase-admin/storage');
    const app = initializeApp({projectId: 'demo-direct-ota', storageBucket: 'demo-direct-ota.appspot.com'}, 'conformance');
    t.after(() => deleteApp(app));
    const provider = createFirebaseProvider({db: getFirestore(app), bucket: getStorage(app).bucket(), trust: config,
      uploadSecret: randomBytes(32).toString('base64'), eventsEnabled: true});
    const result = await testProvider(config, identity, {write: true,
      fetcher: (url, options) => provider.fetch(new Request(url, options))});
    assert.equal(result.mode, 'isolated-write');
    assert(result.checks.includes('synthetic channel withdrawn'));
    const event = await provider.fetch(new Request('https://direct-ota-test.web.app/events', {method:'POST',
      headers:{'Content-Type':'application/json'}, body:JSON.stringify({releaseId:result.releaseId,event:'download_failed'})}));
    assert.equal(event.status, 204);
    const health = await command(config, identity, 'health', {releaseId:result.releaseId},
      (url, options) => provider.fetch(new Request(url, options)));
    assert.equal(health.counts.download_failed, 1);
    const personal = await provider.fetch(new Request('https://direct-ota-test.web.app/events', {method:'POST',
      headers:{'Content-Type':'application/json'}, body:JSON.stringify({releaseId:result.releaseId,event:'ready',installationId:'private'})}));
    assert.equal(personal.status, 400);
    const missing = await provider.fetch(new Request('https://direct-ota-test.web.app/artifacts/ios/invalid'));
    assert.equal(missing.status, 404);
  });
