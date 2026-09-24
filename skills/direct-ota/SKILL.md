---
name: direct-ota
description: Assess, integrate, publish, inspect, withdraw, or roll back signed Direct OTA frontend updates for Capacitor apps using a self-hosted Node service, Supabase, or a compatible provider.
---

# Direct OTA

Read AGENTS.md and docs/compatibility.md first. This tool helps deliver compatible frontend bug fixes and UI updates without another store submission for each web-bundle change. The initial updater integration and subsequent native changes still require native releases.

## Assess or integrate

Identify the app runtime and backend separately. Capacitor 8 is supported by the included adapter. React/Vue/Svelte/Angular inside Capacitor are supported frontend choices; other native runtimes need their own adapter and evidence. Do not answer “yes” to universal compatibility without inspecting the app.

The app can keep any backend. Offer the Node provider, a provider following docs/protocol.md, or Supabase dedicated to updates. Explain that free hosting tiers have quotas.

Follow docs/quickstart.md and the selected provider guide. Generate fresh keys, preserve unrelated work, keep all private material out of Git, and complete the initial native installation. Verify each platform before assigning its production channel.

## Publish

1. Identify the authorized app/environment/platform/channel and intended frontend change.
2. Inspect the diff. Run tests for the changed behavior, type checking, and the production build. Broaden coverage only for affected shared behavior, security, native dependencies, data formats, or backend contracts.
3. Run `npx direct-ota doctor`. Stop OTA preparation on native drift and explain the required native release.
4. Run `prepare`, `upload`, and `promote` for the internal channel using docs/publishing.md. Do not use raw service keys or edit production tables.
5. Verify an actual target app installs and starts healthy, then check the changed feature. Do not call a server response a device test.
6. Promote production through the requested stages. Pause on startup, integrity, or core-flow failures. Use a newer signed rollback or withdrawal instruction if needed.
7. Report the released version, platforms/channels, sequence/release IDs, checks completed, and untested scope. Never include private keys, tokens, or signed upload URLs.

Follow authorization already given by the user. Ask only when a necessary target or consequential action is genuinely unspecified. Never weaken signature validation, runtime matching, archive limits, recovery, or activity guards to finish a publish.
