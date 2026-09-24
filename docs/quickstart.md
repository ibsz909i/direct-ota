# Set up Direct OTA

## 1. Check the app

Use a Capacitor 8 app with a working production web build. Direct OTA does not convert an arbitrary native app into a web app. Review [compatibility](compatibility.md) first.

Install Node 24+ and Python 3 on the publishing machine. Download `direct-ota-0.1.0.tgz` from the [GitHub release](https://github.com/ibsz909i/direct-ota/releases/tag/v0.1.0), then install it in your app:

```sh
npm install ./direct-ota-0.1.0.tgz
```

The package pins `@capgo/capacitor-updater` to 8.51.25. Keep that exact version; an updater upgrade requires reviewing the native overlay and a new native build.

## 2. Choose update hosting

Your app's existing backend can stay where it is.

**Standalone Node service:** choose a stable HTTPS origin, a persistent disk, and a reverse proxy. The supplied SQLite provider runs as one service instance. Follow [the Node guide](providers/node.md).

```sh
npx direct-ota init --app-id app.example.demo --base-url https://updates.example.com --provider node
npx direct-ota export-provider --provider node --out ./ota-service
```

**Supabase:** use an existing reviewed project or a separate project only for updates. Follow [the Supabase guide](providers/supabase.md). Use your own project URL:

```sh
npx direct-ota init --app-id app.example.demo --base-url https://YOUR_PROJECT.supabase.co --provider supabase
npx direct-ota export-provider --provider supabase --out ./ota-service
```

Deploying a provider is a separate step from initializing the client. Follow its guide, set its public trust configuration, and verify that anonymous clients can check for updates but cannot publish them. Keep any provider service credentials on the server.

`direct-ota.config.json` is public configuration. `.direct-ota/identity.json` is private. Back up the identity encrypted, restrict its access, and never commit it. Losing it without a backup requires a new native release with new keys. Read [SECURITY.md](../SECURITY.md).

Check `webDir` and `runtimeInputs` in the generated configuration. Set your actual build output directory and include every native source, configuration, dependency lockfile, and platform directory you ship. Remove a platform directory only if your app does not have that platform.

## 3. Integrate the native updater

Ensure your native iOS/Android projects already exist. Then:

```sh
npx direct-ota native --channel internal
```

Merge the generated `direct-ota.capacitor.json` into the `CapacitorUpdater` plugin configuration of `capacitor.config.ts`; preserve unrelated plugins and settings. See the [native guide](native-integration.md) for the exact configuration and patch lifecycle.

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
