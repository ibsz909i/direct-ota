# Verification for 0.4.0

The following checks were performed on the generalized Direct OTA package. The [case study](case-study.md) separately describes observations from the original integration.

## Automated checks

- TypeScript type checking and production library build.
- Signed manifest and command validation, including wrong keys/purposes, altered signatures, exact artifact hosts/paths, bounds, and compatibility.
- Public-configuration rejection of private PEM/JWK material, private identity permissions, and create-only initialization.
- Packaging rejection of credential markers, source maps, links, unsafe entries, and oversized content.
- Native patch hashes, idempotent installation, drift rejection, trust/source fingerprints, and stale generated/native configuration detection.
- Synthetic native Swift signature verification, shared Swift/Java/TypeScript SemVer corpus, and CLI-generated bundle decryption through the pinned upstream Swift CryptoCipher.
- Client activity guards, retained mandatory requirements, timed retries, background/offline pauses, permanent-error handling, and metadata retry throttling.
- Standalone provider authorization, replay, concurrent publication, immutable artifacts, byte ranges, and persistence.
- Supabase handler admission, bounded runtime catalog lookup, signature checks, and verified-artifact promotion.
- SQL migration, privileges, restrictive Storage policies against deliberately broad legacy policies, replay, concurrent compare-and-swap, rollback, and direct withdrawal in an isolated PostgreSQL 17 database.
- A local HTTPS integration using the real CLI: initialize, prepare, upload twice, promote, download/hash-check, staged rollout, rollback, and withdraw.
- The short `publish` path: host build failure leaves the channel untouched; a successful build creates, uploads, promotes, and confirms an internal release. Direct production publishing is refused.
- Preparation rejects an Android release when only an iOS native target is synced.
- The read-only remote doctor: detects an empty deployed channel, verifies a signed active manifest, artifact size, byte-range support and full SHA-256, and rejects corrupted delivered bytes.
- Guided setup preview and application in a synthetic Capacitor 8 host: app and platform detection, no changes in preview, create-only identity/provider output, public SQL and Edge trust values, private file permissions, and refusal to overwrite existing work.
- Cloudflare provider export from the actual package, Worker type checking and bundle dry run, plus local Workerd/D1/R2 integration: signed publication, rejected altered upload, create-only artifact write, byte ranges, rollback, withdrawal, replay, and competing channel promotions. A 200-request concurrent metadata sample completed successfully against the local Worker.
- JSON Capacitor config fingerprinting: generated updater settings do not create a runtime loop; other native configuration changes still change the fingerprint. Symlinked native patch targets are rejected.

Run `npm run check` for the portable suite. Native Swift checks require macOS/Xcode; the Java corpus requires a JDK. SQL tests are opt-in with `DIRECT_OTA_SQL_TEST=1` and a **disposable local** PostgreSQL instance; see the provider guide. The GitHub workflow runs the SQL harness against a fresh PostgreSQL service.

## Fresh native fixture

A newly created Capacitor 8 project installed the 0.2.0 package tarball, ran guided setup, merged the generated settings, and synced the native projects. It compiled successfully for the iOS Simulator with Xcode and for Android with Gradle/OpenJDK 21. The final native overlays were used. After iOS package resolution, the runtime was regenerated, both platforms were rebuilt, and `direct-ota doctor` verified generated and copied native plugin settings. This native build evidence is from 0.2.0; versions 0.3.0 and 0.4.0 change publishing and provider code, not the native overlay.

## Isolated live Cloudflare test

On September 25, 2026, a dedicated test Worker, D1 database, and private R2 Standard bucket were created in the connected Cloudflare account. No NAMAA or other application resource was modified. The D1 migration applied remotely; the Worker deployed with generated synthetic public trust and a separate random upload secret. A synthetic iOS runtime published one encrypted 176-byte archive through the normal CLI. Live `doctor --remote` verified the signed manifest, artifact size, `206` byte range, and full SHA-256. A production test channel advanced through rollout, withdrawal, and rollback. Two simultaneous signed promotions produced one success and one conflict; replay and altered command signatures were rejected. A burst of 100 concurrent metadata checks succeeded, with observed p50 around 940 ms and p95 around 1,837 ms from this Mac and network. These are sample measurements, not a throughput guarantee.

After moving upload capabilities from URL queries into request headers, a second isolated Worker/D1/R2 deployment repeated the signed CLI upload and promotion. The live Worker rejected missing-header and query-token uploads with `403` and altered archive bytes with `400`. Remote doctor again verified the signed manifest, size, byte range, and SHA-256. The local integration test also covers a modified capability header. The second Worker, database, object, bucket, and synthetic local identity were removed; subsequent Wrangler listings showed no D1 databases or R2 buckets in this test account.

The account's R2 activation checkout showed a $0 base fee and usage-based overage terms. The temporary Worker, D1 database, R2 object, and bucket were deleted after the test. The R2 subscription was canceled and the dashboard showed it ending October 25, 2026; billable usage at that check was $0.00. Account-wide billing and quota history are outside this code test; operators must review them for their own rollout.

A successful compile proves native integration can build. It does not prove every OS/device/network combination, a healthy installed app, or an end-to-end physical-device update.

## Publication checks

The release is packaged from this separate repository, with no private application's Git history. The published source/history and package contents are checked for credentials and private application identifiers. The tarball is installed into a separate consumer directory to verify its CLI and package exports.

## Limits

- No independent security certification or 100,000-device load test is claimed.
- The live Cloudflare sample used one tiny artifact and 100 concurrent checks. It does not establish capacity for hundreds of thousands of phones, physical-device behavior, regional latency, or a zero-cost production fleet.
- Local SQL tests emulate the relevant Storage tables and roles. They do not replace a deployment test against actual Supabase Storage, Edge Functions, gateway settings, or advisors.
- This generalized package has no recorded physical-device fleet acceptance. Adopters must verify their own first native release and both production channels.
- The standalone Node provider is a single-instance deployment with persistent local state. It is not a distributed database or a hosted service with an SLA.
- New runtime/backend adapters need their own tests and integration evidence before being advertised as supported.

Before broad production rollout, exercise interrupted downloads, network changes and cellular consent, force-quit recovery, storage failures, startup rollback, and the app's protected business actions on the actual supported platforms. Use staged deployment and record the observed results.
