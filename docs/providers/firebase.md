# Firebase provider deployment

The Firebase provider uses Hosting for a stable HTTPS origin, a Node 22 Cloud Function for signed metadata and administration, Firestore for channel state, and a private Cloud Storage bucket for encrypted artifacts. The host app can use any backend. Use a **dedicated Firebase project** for OTA: this template deploys deny-all Firestore and Storage client rules, and its Hosting configuration owns the update origin.

Cloud Functions and Cloud Storage require a [Blaze project](https://firebase.google.com/docs/functions/get-started). The local emulator test needs no billing or live resources. Hosting, Functions, Firestore, Storage, and bandwidth can incur charges. This provider is not a zero-cost guarantee or a benchmark for a large fleet.

## Local setup

In a Capacitor 8 app with Direct OTA installed:

```sh
npx direct-ota setup --provider firebase --base-url https://YOUR_PROJECT.web.app --plan
npx direct-ota setup --provider firebase --base-url https://YOUR_PROJECT.web.app
```

The result has `ota-service/`, a private signing identity, public native trust settings, and ignored `.direct-ota/firebase-trust.json` and `.direct-ota/firebase-upload-secret`. It does not change Firebase. The upload secret is a random HMAC key for short-lived upload capabilities; it is not the publisher identity.

Create a dedicated Firebase project, enable Blaze, Firestore, a private Storage bucket, Functions, and Hosting. Confirm the exact project ID and bucket. Then preview the deployment:

```sh
npx direct-ota deploy --provider firebase --target YOUR_PROJECT --bucket YOUR_PRIVATE_BUCKET --plan
```

The plan checks the installed app origin, export, public trust, and local secret permissions. To run the reviewed deployment, use `--apply --dedicated` with the same arguments. It installs the pinned Function dependencies, compiles them, sets two Function secrets from local files, writes an ignored per-project Function env file, and deploys the single OTA function plus Hosting and deny-all client rules. It creates no project, bucket, or billing subscription. **Never run this deployment against an application project with existing Firestore/Storage rules or Hosting content.** For a custom Hosting domain, deploy manually after reviewing the origin and routes.

For a new host prepared by `setup`, `direct-ota setup --finish --provider firebase --target YOUR_PROJECT --bucket YOUR_PRIVATE_BUCKET --plan` previews the native sync and this exact deployment together. Repeat with `--apply --dedicated` only for the reviewed OTA-only project. The command verifies native settings before remote changes and checks each platform's public metadata afterward. Device build and installation, client coordinator wiring, and an internal OTA test remain required.

The bucket stays private. Devices download via `/artifacts/...`; the Function authorizes promoted immutable paths and supports HEAD and byte ranges. The Function reads and verifies object bytes before promotion. Keep upload paths immutable. Do not put source maps, development files, tokens, or privileged logic in frontend bundles.

## Verify

Start with the local Firestore and Storage emulators using a demo project:

```sh
npm ci --prefix providers/firebase/functions
JAVA_HOME=/path/to/JDK21 PATH=/path/to/JDK21/bin:$PATH \
  npx firebase-tools@15.31.0 emulators:exec --project demo-direct-ota \
  --config providers/firebase/firebase.json --only firestore,storage \
  'node --test tests/firebase.integration.test.mjs'
```

The test exports the real package provider and exercises signed publishing, replay rejection, tampered and duplicate uploads, byte ranges, concurrent promotion, rollback, withdrawal, and aggregate events against the emulators. The emulator cannot prove your live IAM, quota, billing, CDN behavior, or physical-device activation.

After deployment, run `direct-ota test-provider` read-only, then `direct-ota test-provider --write` on an isolated service. Write mode publishes and withdraws a synthetic runtime. Run `doctor --remote` and confirm an internal update on physical iOS and Android devices before production assignment.

## Optional health reports

Reports are off by default. Set `OTA_EVENTS_ENABLED=true` in the dedicated Function environment and redeploy to opt in. Also provide `eventsUrl: 'https://YOUR_PROJECT.web.app/events'` to the app's update coordinator. Reports contain only a release UUID and a fixed event name. Successful events are sampled at 1%; errors are unsampled, so counts are **not** exact installation or failure rates. The endpoint validates shape, caps input size, and admits at most 120 events per minute across the service. Read aggregates through signed `direct-ota health --release-id UUID`. Device reports cannot publish or trigger rollback. Monitor costs and keep the flag off if you do not use it.

For 100,000+ phones, review Hosting/CDN cache behavior, Function/Firestore/Storage quotas and pricing, and run an actual staged load test. The current local tests verify correctness, not that capacity target. Keep the native rollback path and operator withdrawal procedure ready.
