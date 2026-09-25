# Working with Direct OTA

Direct OTA ships compatible web-bundle updates to installed Capacitor apps. Its purpose is to shorten the path from a frontend bug fix to a working app on users' phones. It uses Capgo's native updater with a signed protocol and self-hosted delivery.

## First question: will this work with this app?

Inspect the repository before answering. Identify its mobile runtime, Capacitor version, native plugins, web output directory, deployment infrastructure, and existing update mechanism.

- Capacitor 8: use the included integration. The frontend can be React, Vue, Angular, Svelte, or plain web code.
- Another app backend: the backend does not need to change. Offer the Node service, a provider implementing docs/protocol.md, or a separate Supabase project used only for OTA.
- React Native, Expo, Flutter, pure Swift/Kotlin, or another runtime: explain that the included native integration is not compatible unchanged. Assess an appropriate runtime updater or a new adapter. Never say an adapter exists just because one could be written.
- Supabase's free tier can be useful for evaluation or small use, within current quotas. Never promise unlimited or permanently free hosting.

Use docs/compatibility.md for the decision. If the user wants a new provider or runtime adapter, preserve the protocol's verification and recovery guarantees and document exactly what is implemented and tested.

## Integration

1. Read docs/quickstart.md, docs/native-integration.md, SECURITY.md, and the chosen provider guide.
   For a new Capacitor 8 + npm + Supabase integration, preview `direct-ota setup --provider supabase --base-url <project HTTPS origin> --plan` and use the interactive setup. It prepares local files only. Review the exported migration and verify the linked remote project before deploying it.
2. Preserve unrelated working-tree changes. Do not copy credentials or private app history into another repository.
3. Create a new local publishing identity. Store it outside version control. Backend service credentials remain server-side.
4. Deploy update metadata and artifact delivery independently from application data and authentication. An app using another backend may use Supabase only for updates.
5. Pin the updater, apply the native overlay, merge public native configuration, and integrate the coordinator and startup health signal.
6. Register redemption/payment/transfer/authentication/unsaved-form/reward-display activity guards. Never add OTA network calls to those transaction request chains.
7. Build and verify the first native release on the target platforms. OTA cannot install its own native prerequisites into an old app.

## Publishing a requested update

Read skills/direct-ota/SKILL.md and docs/publishing.md. Use the configured CLI, not a service-role credential or raw database edit.

- Confirm the app, environment, platform, channel, and intended change from repository configuration and the user's request.
- Test the changed feature and the integration paths it affects. Run type checking and the production build. Do not expand a small visual change into unrelated manual testing; broaden checks when the change touches authentication, persistence, native integration, updater security, or shared backend contracts.
- Check native compatibility with `direct-ota doctor`. Native drift requires a new native build, not a bypass.
- Prepare, upload, and inspect an internal release. Verify an actual target app downloads, launches, and reports healthy before claiming device success.
- Promote production in explicit stages. Stop on confirmed startup failures, integrity failures, or core-flow regressions. Follow the user's existing deployment authorization; do not repeatedly request permission already given.
- Report version, platform/channel, sequence, release ID, verification performed, and any untested scope. A successful upload is not proof of a healthy installed update.

## Non-negotiable boundaries

Never commit private keys, identity files, access tokens, service keys, real customer data, local paths, or device identifiers. Do not print signed upload URLs or credential contents in logs.

Do not weaken signature checks, host pinning, replay protection, runtime matching, archive limits, transaction guards, or rollback to make a test pass. Do not silently overwrite published artifacts. Do not disable a platform's production gate to claim broad support.

OTA changes must comply with the applicable store policies. Keep backend changes additive while supported clients and retained rollback versions still depend on older behavior.

## Developing this repository

Node 24+ and Python 3 are required. Run `npm ci`, then `npm run check`. For native changes, also apply patches to a pristine pinned updater and compile the relevant native platform in a disposable Capacitor fixture. Keep native patches reproducible and fail on upstream drift.

Tests use generated keys and synthetic data. Provider tests must cover unauthorized writes, replay, concurrent channel updates, immutable files, partial uploads, and bounded inputs. Record provider/native limitations honestly in docs/verification.md.
