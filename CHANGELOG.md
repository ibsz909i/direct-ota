# Changelog

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
