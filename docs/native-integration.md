# Native integration

Direct OTA's native client supports Capacitor 8 on iOS and Android with `@capgo/capacitor-updater` pinned to `8.51.25`. Other host frameworks need their own native verifier, downloader, activation guard, and readiness bridge before they can use this client. The HTTP backend contract is separate from the host framework.

## Install and configure

1. Create `direct-ota.config.json` with your own app ID, HTTPS check and artifact URLs, signing public JWK, bundle public key, and runtime inputs. Keep all private keys outside the app and public repository.
2. In the host Capacitor 8 app, run `npm install --save-exact ./direct-ota-0.1.0.tgz @capgo/capacitor-updater@8.51.25 @capacitor/app@8`. Ensure Capacitor CLI 8 is installed in the host project. Both native plugins must be direct app dependencies. If `includePlugins` is set globally or per platform, include both there too. Add the iOS and Android platforms and run an initial `npx cap sync`.
3. Run `npx direct-ota native --channel internal` for an internal binary or `npx direct-ota native --channel production` for a production binary. This verifies the pristine Capgo source hash before patching and writes `direct-ota.runtime.json` and `direct-ota.capacitor.json`.
4. Merge the generated plugin settings into `capacitor.config.ts`:

```ts
import type {CapacitorConfig} from '@capacitor/cli';
import updater from './direct-ota.capacitor.json';

const config: CapacitorConfig = {
  appId: 'app.example.demo',
  appName: 'Example',
  webDir: 'dist',
  plugins: {CapacitorUpdater: updater},
};
export default config;
```

5. Run `npx direct-ota native --channel <same-channel>` again after changing `capacitor.config.ts`, then `npx cap sync` and `npx direct-ota doctor`. If sync changed a declared native input, regenerate the runtime config, sync, and check again before building. A runtime mismatch requires a new native binary; do not use the old runtime for a web release.

The generated settings turn off Capgo auto update, disable unverified URL changes, retain failed/previous bundles for recovery, set a 30 second readiness watchdog, and pin the app ID, environment, artifact base URL, backend contract, runtime hash, channel, ES256 verification key, and bundle encryption public key inside the binary. The public project identity stays in SPKI PEM format; `native` converts only Capgo's generated `publicKey` setting to the PKCS#1 PEM format its iOS and Android decryptors require. The artifact request URL must be exactly `artifactBaseUrl + '/' + signedPath`; redirects are rejected. The native bridge exposes `otaState`, `otaAccept`, `otaDownload`, `otaPause`, `otaActivate`, and `otaReady` and emits `otaStateChange`.

After `npm ci`, run `npx direct-ota patch` before `npx cap sync` or native compilation. The patch command checks the pinned upstream hashes and only reinstalls the verified overlay. It does not change the runtime fingerprint. Any upstream or already patched drift fails the operation. Use `native` only when intentionally preparing a new native binary and runtime.

## Start and acknowledge local health

The app starts the updater during native boot. Acknowledge readiness only after the local route shell has mounted, local initialization has completed, and a persistent storage probe succeeds. Network login or a remote API request is not a local health condition.

```ts
import {startUpdater, markReady, mountUpdateUi, updateActivity} from 'direct-ota';
import project from './direct-ota.config.json';

const updater = await startUpdater({
  checkUrl: project.checkUrl,
  eventsUrl: project.eventsUrl,
});
const stopUi = mountUpdateUi({
  coordinator: updater.coordinator,
  appRoot: document.getElementById('root')!,
  strings: translations[currentLanguage].ota,
  direction: currentLanguage === 'ar' ? 'rtl' : 'ltr',
});

// Call this from the host's committed route shell, after local setup.
await markReady(updater);

// Wrap transactions that should finish before mandatory activation.
const finish = updateActivity.begin();
try { await saveOpenForm(); } finally { finish(); }

// On app teardown: stopUi(); updater.stop();
```

`mountUpdateUi` is optional. It accepts all visible strings from the host, supports RTL, gives progress and recovery controls, and blocks the app while an already verified mandatory update is active. `startUpdater` installs a conservative DOM guard for edited forms and open modal dialogs. For a custom interaction model, pass `protectDom:false` and use the activity guard around critical work. An app can subscribe to `updater.coordinator` to render its own UI.

`markReady` is idempotent. It waits two animation frames, probes local storage, then calls native `otaReady` and starts checks. An invalid or missing native trust configuration makes `startUpdater` reject with `OTA_CONFIG`; the host should display a configuration error and avoid using legacy Capgo download or activation APIs. Native patch gates reject those APIs even when configuration is invalid.

## Retry, consent, and compatibility

The coordinator retries transient metadata and download errors with bounded backoff. It keeps a previously accepted mandatory update active if a check fails or returns no manifest. Cellular transfer requires an explicit user action; native consent and partial bytes persist for resume. Integrity and storage failures require visible recovery and do not loop automatically. The native layer validates the ES256 signature, app and runtime compatibility, exact artifact URL, archive hash, encrypted bundle checksum, ZIP entry bounds, and activation state before switching bundles. It quarantines failed bundles and rolls back a bundle that does not signal local readiness within the watchdog window.

The runtime fingerprint hashes declared native inputs by sorted path and bytes, the pinned trust configuration, and Direct OTA's native patch specification and overlay sources. Capacitor generated web assets and config copies are excluded. Native source, native resources, plugin registrations, and `Package.resolved` are included because their resolved contents affect the binary. The first sync or Xcode package resolution can therefore require regenerating the runtime and building again; `doctor` must pass after the final sync/build. The internal or production channel in `direct-ota.capacitor.json` does not itself change the runtime hash, but each channel remains a distinct signed selector pinned in its binary.
