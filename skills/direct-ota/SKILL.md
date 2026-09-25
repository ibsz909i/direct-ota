---
name: direct-ota
description: Assess, integrate, publish, inspect, withdraw, or roll back signed Direct OTA frontend updates for Capacitor apps using Node, Supabase, Cloudflare, Firebase, or a compatible provider.
---

# Direct OTA

Read AGENTS.md and docs/compatibility.md first. This tool helps deliver compatible frontend bug fixes and UI updates without another store submission for each web-bundle change. The initial updater integration and subsequent native changes still require native releases.

## Assess or integrate

Identify the app runtime and backend separately. Capacitor 8 is supported by the included adapter. React/Vue/Svelte/Angular inside Capacitor are supported frontend choices; other native runtimes need their own adapter and evidence. Do not answer “yes” to universal compatibility without inspecting the app.

The app can keep any backend. Offer the Node, Cloudflare Worker/D1/R2, Firebase, or Supabase provider, or a custom provider built with `create-provider`. Explain that hosting tiers have quotas and Firebase Functions/Storage require Blaze.

Follow docs/quickstart.md and the selected provider guide. For a new Capacitor 8 + npm + Supabase host, run `direct-ota setup --provider supabase --base-url <project HTTPS origin> --plan` before its interactive local setup. The command does not deploy Supabase resources or merge host application code. Review the target project and exported SQL before remote deployment. Generate fresh keys, preserve unrelated work, keep all private material out of Git, and complete the initial native installation. Verify each platform before assigning its production channel.

For Cloudflare, use `direct-ota setup --provider cloudflare --base-url <Worker HTTPS origin> --plan`, then read docs/providers/cloudflare.md. Keep D1 and R2 resources separate from unrelated projects. Do not claim a large fleet will fit the Workers Free daily request limit. If R2 is disabled or live credentials are unavailable, complete local Worker tests and report the live deployment gap without claiming deployment succeeded.

After local setup and provisioning an isolated Cloudflare or Firebase service, preview `direct-ota setup --finish --provider ... --plan` with the exact account/project and bucket. Use `--apply --dedicated` only after reviewing that plan. It syncs native settings, deploys the dedicated service, runs read-only conformance, and checks metadata; it does not build or test a device. For a shared Supabase project, review and apply migrations through its provider guide. Run `doctor` for a readiness report and use `doctor --fix` only for safe generated/JSON config repair. Never use `--fix` to bypass native drift.

For Firebase, use a dedicated OTA project and `setup --provider firebase --base-url https://PROJECT.web.app --plan`. Read docs/providers/firebase.md. Run local Firestore/Storage emulator conformance before deployment. `deploy --plan` validates the selected update service; `--apply --dedicated` mutates the exact pre-provisioned provider and must never target an existing application project. For any provider, use `test-provider` read-only and `test-provider --write` only against an isolated deployment. Health reports are optional, untrusted, and supported by Cloudflare and Firebase.

## Publish

1. Identify the authorized app/environment/platform/channel and intended frontend change.
2. Inspect the diff. Run tests for the changed behavior and type checking. Broaden coverage only for affected shared behavior, security, native dependencies, data formats, or backend contracts.
3. Run `npx direct-ota publish --platform ios|android --version SEMVER` for each target. It runs the host build, local native doctor, prepare, upload, internal promotion, and channel confirmation. Do not use raw service keys or edit production tables. If it fails after preparation, check status and use the retained release directory for a safe retry.
4. Run `npx direct-ota doctor --remote --platform ios|android` to check the deployed public metadata, byte ranges, and artifact hash. Stop on native drift or remote failure.
5. Verify an actual target app installs and starts healthy, then check the changed feature. Do not call a server response a device test.
6. Promote production through the requested stages. Pause on startup, integrity, or core-flow failures. Use a newer signed rollback or withdrawal instruction if needed.
7. Report the released version, platforms/channels, sequence/release IDs, checks completed, and untested scope. Never include private keys, tokens, or signed upload URLs.

Follow authorization already given by the user. Ask only when a necessary target or consequential action is genuinely unspecified. Never weaken signature validation, runtime matching, archive limits, recovery, or activity guards to finish a publish.
