# Changelog

## 0.6.0

- Add a per-gate `doctor` readiness report and `doctor --fix` for generated settings and a JSON host config that belongs to the same publishing identity. Native runtime drift and another updater identity still fail closed.
- Add reviewed `setup --finish` for pre-provisioned, dedicated Cloudflare and Firebase services. It merges simple JSON/TypeScript host settings, converges native sync, deploys only the selected resources, runs read-only conformance, and verifies platform metadata. Supabase migrations remain a separate reviewed operation.

## 0.5.0

- Add a Firebase provider with private Storage artifacts, atomic Firestore release state, deny-all client rules, and local emulator conformance.
- Add a reusable provider admission SDK and custom provider scaffold.
- Add read-only and isolated write provider conformance commands for signed publishing, immutable artifacts, ranges, rollback, and withdrawal.
- Add local deployment preflight and explicitly scoped Cloudflare/Firebase deployment commands for pre-provisioned update-only resources.
- Add optional bounded aggregate release events for Cloudflare and Firebase. Device reports cannot authorize publication or rollback.


## 0.4.0

- Add an isolated Cloudflare Worker, D1, and R2 provider with signed publishing, immutable uploads, byte-range downloads, bounded metadata caching, rollback, and withdrawal.
- Support Cloudflare in local guided setup, provider export, documentation, and a real local Worker integration test.

## 0.3.0

- Add one-command internal publishing that builds the host app, preserves immutable candidates, and confirms the promoted channel head.
- Add a read-only remote doctor that verifies signed metadata, public artifact integrity, and byte-range support.
- Refuse a platform release when that platform has no synced native configuration.

## 0.2.0

- Guided local Supabase setup for Capacitor 8 apps, with a read-only plan and explicit application.
- Detect the host app ID, web directory, and native platforms; export project-specific public setup SQL and an ignored Edge trust file.
- Keep remote database, Storage, and Edge Function deployment under explicit operator control.

## 0.1.0

Initial public release.

- Signed release manifests and short-lived publishing commands.
- Local publishing CLI with immutable candidates, staged rollouts, withdrawal, and rollback.
- Pinned Capacitor updater integration for iOS and Android.
- Supabase and standalone Node provider implementations.
- Backend-independent protocol, integration guides, and AI agent workflow.
