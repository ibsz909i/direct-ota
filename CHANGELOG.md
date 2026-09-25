# Changelog

## Unreleased

- Allow explicitly pinned larger bundle ceilings across packaging, signed metadata admission, iOS, and Android; preserve the original defaults for existing apps.
- Include an internal publishing GitHub Action with private temporary identity handling and a reviewed CI example.
- Preserve upgrades from the prior native overlay using exact known hashes, and widen isolated Cloudflare and Supabase storage constraints without changing prior migration files.
- Make optional success-event sampling stable per installation and release without sending the installation ID; throttle untrusted check hints and allow a bounded 5–60 minute check interval.
- Aggregate bounded download duration, bytes, and retry measurements on opt-in Cloudflare and Firebase event endpoints; add an optional stop-only gate for manually requested rollout stages.
- Add signed background releases that download on Wi-Fi without blocking protected actions and activate on the next process start; retain required updates as the default.
- Align iOS and Android native UUID admission with the shared protocol and reject normalized invalid iOS dates; expand the signed Swift malformed-manifest corpus.
- Reject ambiguous, noncanonical, non-file, and overly long ZIP entry names consistently during packaging and native installation.
- Add signed local release provenance, `inspect`, and paginated local candidate history. Doctor now names changed native inputs when a recorded runtime drifts.
- Add signed, paginated publisher-only remote history and promoted-release inspection for the Node, Cloudflare, Firebase, and Supabase providers.
- Allow project-specific literal deny markers in bundle scanning, with exact-file exceptions that cannot bypass built-in credential checks.
- Add a local release verification command that checks the package version, full test suite, dependency audit, tarball contents, installed CLI/exports, and SHA-256 before publication.

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
