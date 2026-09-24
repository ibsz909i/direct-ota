# Operating an update service

## Availability

A failed metadata check must not block startup when the device has no known required update. Once a required release is accepted, an interrupted download retains progress and shows recovery controls until it succeeds or the release is withdrawn. Startup rollback is a safety exception to mandatory updating.

Keep metadata small and separate from artifact delivery. Artifact URLs must stay stable for the lifetime of supported native apps and rollback versions. Do not put the publishing laptop in the download path.

## Capacity

The Node provider is a single-instance reference service with SQLite and a persistent filesystem. Do not run independent replicas against different disks and call that a consistent channel service. Use a tested shared transactional provider when scaling beyond that topology.

Supabase shares quotas and infrastructure with other workloads in the same project. A separate OTA project can isolate some operational concerns, but still needs bandwidth and function capacity planning.

Before a large rollout, measure your actual request rate, latency, failure rate, object-download throughput, cache behavior, and retry amplification. Use jittered/debounced client checks, immutable artifact caching, edge admission limits, and explicit rollout stages. Add no metadata request to a redemption or payment request chain.

A 3 MB archive × 100,000 downloads is roughly 300 GB before retries. There is no claim that a default deployment has passed a 100,000-device load test.

## Monitoring

Monitor provider latency and errors, storage/egress use, upload/promote outcomes, startup failures, and device rollback reports when telemetry is configured. Device reports are untrusted evidence; they cannot authorize publishing or server-side rollback.

Do not collect account IDs, student information, transactions, tokens, or full upload URLs. Retain detailed operational events only as long as needed; seven days for raw events and ninety days for release summaries are useful starting points. Configure retention at the chosen provider rather than allowing unbounded logs.

Stop further promotion on confirmed startup failures, signature/verification failures, or regressions in a core flow. Withdraw or issue a newer rollback instruction and investigate before advancing rollout.

## Backups and cleanup

Back up metadata, audit state, and immutable artifacts consistently. Keep release directories for recent successful versions. Never garbage-collect an artifact still referenced by a supported channel or required for rollback. Clean abandoned uploads only after their capabilities expire and no reservation/promotion needs them.

Test a restore in an isolated environment. Restoring an old database snapshot can regress sequence numbers; reconcile against published history before serving devices again.

## Native upgrades

Native plugins, permissions, custom Swift/Kotlin, trust keys, updater versions, and relevant configuration require a new native build. Keep release channels separated by native runtime. Old installed native versions should receive only compatible web bundles.

Local data and backend changes must support the retained rollback versions. An additive migration followed by a frontend release is safer than removing behavior still used by installed apps.
