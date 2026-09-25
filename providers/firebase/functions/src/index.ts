import {getApps, initializeApp} from 'firebase-admin/app';
import {getFirestore} from 'firebase-admin/firestore';
import {getStorage} from 'firebase-admin/storage';
import {onRequest} from 'firebase-functions/v2/https';
import {defineSecret} from 'firebase-functions/params';
import {createFirebaseProvider} from './state.js';
import {validateTrust, type OtaTrust} from './protocol.js';

const trustSecret = defineSecret('OTA_TRUST_JSON');
const uploadSecret = defineSecret('OTA_UPLOAD_SECRET');
let service: ReturnType<typeof createFirebaseProvider> | undefined;

function provider() {
  if (service) return service;
  const trust = validateTrust(JSON.parse(trustSecret.value()) as OtaTrust);
  const bucketName = process.env.OTA_BUCKET_NAME;
  if (!bucketName || !/^[a-z0-9][a-z0-9._-]{2,222}$/.test(bucketName)) throw Error('OTA_BUCKET_NAME is required');
  if (!getApps().length) initializeApp();
  service = createFirebaseProvider({db: getFirestore(), bucket: getStorage().bucket(bucketName),
    trust, uploadSecret: uploadSecret.value(), publisherEnabled: process.env.OTA_PUBLISHER_ENABLED !== 'false',
    eventsEnabled: process.env.OTA_EVENTS_ENABLED === 'true'});
  return service;
}

/** Hosting rewrites only the five OTA paths to this function. */
export const directOta = onRequest({region: 'us-central1', memory: '512MiB', concurrency: 8,
  maxInstances: 100, timeoutSeconds: 60, secrets: [trustSecret, uploadSecret]}, async (req, res) => {
  try {
    const url = new URL(req.originalUrl, `https://${req.hostname}`);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers.set(name, value);
    }
    const request = new Request(url, {method: req.method, headers,
      ...(req.method === 'GET' || req.method === 'HEAD' ? {} : {body: new Uint8Array(req.rawBody ?? Buffer.alloc(0))})});
    const result = await provider().fetch(request);
    result.headers.forEach((value, name) => res.setHeader(name, value));
    res.status(result.status);
    if (req.method === 'HEAD' || !result.body) { res.end(); return; }
    res.end(Buffer.from(await result.arrayBuffer()));
  } catch {
    res.status(503).set('Cache-Control', 'no-store').json({error: 'OTA_UNAVAILABLE'});
  }
});
