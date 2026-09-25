# Set up Direct OTA

## 1. Check the app

Use a Capacitor 8 app with a working production web build. Direct OTA does not convert an arbitrary native app into a web app. Review [compatibility](compatibility.md) first.

Install Node 24+ and Python 3 on the publishing machine. Download `direct-ota-0.5.0.tgz` from the [GitHub releases](https://github.com/ibsz909i/direct-ota/releases), then install it in your app:

```sh
npm install --save-exact ./direct-ota-0.5.0.tgz @capgo/capacitor-updater@8.51.25 @capacitor/app@8
```

The host app must list both native plugins directly so Capacitor discovers them. The package pins `@capgo/capacitor-updater` to 8.51.25; keep that exact version. An updater upgrade requires reviewing the native overlay and a new native build. Use Capacitor CLI 8 in the host project. If `capacitor.config` uses `includePlugins`, include both `@capgo/capacitor-updater` and `@capacitor/app` for each platform.

## 2. Choose update hosting

Your app's existing backend can stay where it is.

**Standalone Node service:** choose a stable HTTPS origin, a persistent disk, and a reverse proxy. The supplied SQLite provider runs as one service instance. Follow [the Node guide](providers/node.md).

**Firebase:** use a separate Blaze project with Hosting, a Cloud Function, Firestore, and private Storage. Follow [the Firebase guide](providers/firebase.md). Guided local setup and a reviewed deployment preflight are available; neither enables billing or creates resources.

```sh
npx direct-ota init --app-id app.example.demo --base-url https://updates.example.com --provider node
npx direct-ota export-provider --provider node --out ./ota-service
```

**Supabase:** use an existing reviewed project or a separate project only for updates. The guided command requires a Capacitor 8 app with npm's `package-lock.json`, at least one native platform, and both native plugins installed as direct dependencies. It reads your Capacitor app ID and web directory. Preview its changes, then run it interactively:

```sh
npx direct-ota setup --provider supabase --base-url https://YOUR_PROJECT.supabase.co --plan
npx direct-ota setup --provider supabase --base-url https://YOUR_PROJECT.supabase.co
```

The setup creates the private identity and public config, exports a provider to `ota-service/`, fills its public `setup.sql` values, writes an ignored `.direct-ota/supabase-trust.env` file, applies the pinned native overlay, and generates native settings. No remote Supabase action occurs. For a noninteractive local setup after reviewing `--plan`, use `--yes`. Existing Direct OTA identities, generated files, and provider output are never overwritten. If a local step fails, inspect the files already created and continue using the manual commands; do not regenerate a new signing identity for an app already installed on devices.

Follow [the Supabase guide](providers/supabase.md) to review the SQL and deploy to the *intended* linked project. Then merge the generated native settings, sync and build the app, run `doctor`, and test an internal OTA on a device. Setup does not make the app ready for OTA by itself.

**Cloudflare:** choose a stable Worker HTTPS origin and a dedicated D1 database and R2 bucket. The guided command has the same host requirements and local-only behavior as the Supabase setup:

```sh
npx direct-ota setup --provider cloudflare --base-url https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev --plan
npx direct-ota setup --provider cloudflare --base-url https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev
```

It exports a Worker, generates ignored trust and upload-secret files, and prepares native settings. Follow [the Cloudflare guide](providers/cloudflare.md) for deployment. Cloudflare R2 must already be enabled on the intended account. The setup never creates a Worker, D1 database, R2 bucket, or release remotely.

**Manual Supabase path:** for an existing Direct OTA integration or a host that does not meet the guided setup's npm/Capacitor requirements:

```sh
npx direct-ota init --app-id app.example.demo --base-url https://YOUR_PROJECT.supabase.co --provider supabase
npx direct-ota export-provider --provider supabase --out ./ota-service
```

Deploying a provider is a separate step from initializing the client. Follow its guide, set its public trust configuration, and verify that anonymous clients can check for updates but cannot publish them. Keep any provider service credentials on the server.

`direct-ota.config.json` is public configuration. `.direct-ota/identity.json` is private. Back up the identity encrypted, restrict its access, and never commit it. Losing it without a backup requires a new native release with new keys. Read [SECURITY.md](../SECURITY.md).

Check `webDir` and `runtimeInputs` in the generated configuration. Set your actual build output directory and include every native source, configuration, dependency lockfile, and platform directory you ship. Remove a platform directory only if your app does not have that platform.

## 3. Integrate the native updater

For a manual integration, ensure your native iOS/Android projects already exist. Then:

```sh
npx direct-ota native --channel internal
```

Merge the generated `direct-ota.capacitor.json` into the `CapacitorUpdater` plugin configuration of `capacitor.config.ts` or `capacitor.config.json`; preserve unrelated plugins and settings. For JSON, repeat `native` after the merge, then sync. See the [native guide](native-integration.md) for the exact configuration and patch lifecycle.

Run Capacitor sync and finalize your native configuration. Run `native` again after those setup changes so the recorded fingerprint describes the app you are building. Run `doctor` to check it. Use the generated configuration consistently for the native build and the published release.

Reapply the native overlay after a clean dependency install, before syncing or compiling native code. A dependency update that no longer matches the pinned source must fail; do not force patches onto a different updater version.

## 4. Wire the app lifecycle

Start the coordinator early in the native app, mount your update UI, and call `markReady` after the local shell and required local storage initialization succeed. Do not wait for network login or a backend request to mark local startup healthy.

The [native guide](native-integration.md) shows the framework-neutral API, optional DOM UI, and activity guard. Use the guard around sensitive operations and keep displayed reward codes or unsaved forms protected until they can safely close. A guard should be released in `finally` when its operation finishes.

Your first native build must already include the verifier, public keys, coordinator, UI, and startup health signal. A later OTA cannot retrofit these native prerequisites.

## 5. Verify and release

Build the native app with Xcode/Android tooling and install it on an internal test device for each platform. Confirm launch, local health, a small signed update, interrupted-download recovery, and startup rollback in a disposable test setup.

Use [publishing.md](publishing.md) for the first internal update and staged production release. Make production native builds with the production channel configuration and verify their runtime before targeting them. Keep previously promoted compatible artifacts for rollback.

Only claim verification for the devices, providers, and network conditions actually tested. The public library cannot certify every app-specific integration.
