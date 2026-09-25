# Supabase provider deployment

This provider uses PostgreSQL for release state, Storage for distributable artifacts, and two Edge Functions. It can run in a separate OTA project while your app keeps its existing backend. No application accounts, authentication tables, balances, or transaction data are required.

## Export and configure

For a new npm-based Capacitor 8 app, `direct-ota setup --provider supabase --base-url https://YOUR_PROJECT.supabase.co --plan` previews the local setup. Running it interactively creates a fresh identity, exports this provider into `ota-service/`, fills `setup.sql` with the public app values, writes an ignored `.direct-ota/supabase-trust.env`, and prepares the native overlay and settings. It makes **no remote Supabase changes**. Review the result before deploying. Use the commands below when integrating manually or continuing an existing setup.

```sh
npx direct-ota init --app-id app.example.demo --base-url https://YOUR_PROJECT.supabase.co --provider supabase
npx direct-ota export-provider --provider supabase --out ./ota-service
```

The export copies the canonical protocol into `functions/_shared/protocol.ts`. The repository template contains a development re-export; export before deployment so the functions do not depend on files outside their workspace.

Create a Supabase CLI workspace with `supabase init`. Copy the exported `functions/` and `migrations/` directories into its `supabase/` directory and merge the exported function entries into `supabase/config.toml`. Preserve unrelated configuration. Link the intended project, inspect the migration, and apply it with `supabase db push`.

For manual exports, edit the exported `setup.sql` with the public app ID, environment, key ID, artifact base, and backend contract from `direct-ota.config.json`. Guided setup fills those public values for you. Review the exact statement and run it once as database owner after the migration. It creates the single enabled publisher configuration. No publisher is enabled by the migration itself. Do not put the EC/RSA private identity in SQL, Edge secrets, or source control.

Set `OTA_TRUST_JSON` in Edge secrets to the public configuration JSON. Guided setup creates `.direct-ota/supabase-trust.env` for `supabase secrets set --env-file` after you have linked and verified the intended project; do not commit that file. Supabase provides `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to the functions. The artifact base must exactly match this project's public `direct-ota` bucket endpoint.

Deploy `direct-ota-check` and `direct-ota-publish` with the supplied `verify_jwt=false` configuration or `--no-verify-jwt`. This intentionally bypasses Supabase's application JWT gate: devices may check while logged out, and publishing uses its own pinned ES256 command authorization. The function verifies purpose, audience, lifetime, nonce shape and nested manifest before the service-only RPC. An anon or user JWT cannot grant publishing rights.

## Storage and authorization

The public `direct-ota` bucket permits distribution of frontend assets; frontend files are inspectable on the device too. It is not a place for secrets. Restrictive policies prevent ordinary anonymous/authenticated roles from modifying this bucket even if the project has broader legacy permissive policies.

Uploads receive a signed capability only after a valid publishing reservation. The service requests Supabase's default create-only upload token and the client supplies `x-upsert:false`. The [Supabase SDK implementation](https://github.com/supabase/storage-js/blob/master/src/packages/StorageFileApi.ts) documents the signed upload route and default behavior. Capabilities expire; the publisher requests a fresh reservation/token when retrying. Do not log them.

Promotion performs a bounded GET of the exact signed public artifact URL, validates its actual byte count and SHA-256, then calls the transactional RPC. SQL verifies the reservation, storage metadata, verified digest, and expected sequence. Reusing old bytes requires a previously promoted compatible artifact. A signed withdrawal has no artifact and promotes directly without a reservation. Retrying an identical current promotion is idempotent.

Private tables have RLS and no direct client or service-role table grants. Only explicitly granted RPCs expose the server operations. The Edge Functions use the service credential server-side; mobile configuration contains no service credential. JSON errors omit internal database details.

## Limits and operations

The check function refreshes a single catalog of at most 256 active heads every 15 seconds, coalesces concurrent refreshes, and backs off for five seconds after a backend error. Unknown runtime values do not create separate database queries. Each isolate admits at most 1,200 requests/minute and 64 concurrent checks. Publishing admits at most 60 requests/minute and 8 concurrent requests per isolate; SQL also limits signed commands to 60/minute.

The schema caps stored release records at 10,000 and reserved distinct artifact bytes at 2 GiB. Abandoned reservations continue counting toward quotas until reviewed cleanup; the template never silently deletes history or rollback artifacts. Nonces are retained beyond their validity window and pruned in bounded batches during signed commands. No optional telemetry endpoint is supplied.

Per-isolate admission is not a distributed denial-of-service defense. Configure upstream admission controls and monitor function/Storage quotas, errors, bandwidth and latency. Measure your actual rollout workload before increasing these limits or targeting a large fleet. There is no claim of a 100,000-phone load test or unlimited/free hosting.

For emergency disablement, run the reviewed configuration update shown in `setup.sql`. Catalog caches may retain metadata for up to 15 seconds. Existing downloaded signatures remain trusted on native devices; a key compromise needs the native trust recovery described in [SECURITY.md](../../SECURITY.md).

Back up release/channel/audit state and artifacts consistently. Preserve sequence history during recovery, and retain artifacts needed by supported runtimes and rollback instructions. Review and apply operational cleanup explicitly; do not mutate Supabase-managed Storage metadata directly to delete objects.

## Verify before production

First run a synthetic internal release against the deployed project: unsigned publishing denied, anon/authenticated bucket writes denied, create-only token behavior, artifact hash and size enforcement, public GET/HEAD/Range delivery, concurrent promotion conflict, rollback and direct withdrawal. Check Supabase security advisors and examine the target project's actual policies. Then verify native download, activation and startup recovery on your intended devices.

Local automated coverage includes cryptographic Edge handler tests, REST adapter request/digest tests, Deno type checking, an isolated PostgreSQL harness applying the actual migrations, and a disposable Docker Supabase Storage test. The SQL harness bootstraps synthetic Storage tables and roles. The Storage test exercises signed upload, create-only behavior, public byte ranges, and anonymous/authenticated write denial over local Supabase HTTP. It does not prove hosted gateway or Edge Function configuration.

With Docker, the Supabase CLI, and `psql` installed, run both local provider checks in a disposable project:

```sh
npm run test:supabase-local
```

The command refuses occupied default Supabase ports, creates the stack from the exported provider, and removes its containers and files after success. It prints test results without printing the local demo keys. On failure it retains the temporary workspace path for diagnosis.

To run that optional SQL harness against a disposable local PostgreSQL server:

```sh
PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=postgres DIRECT_OTA_SQL_TEST=1 node --test tests/supabase-sql.test.mjs
```

The local test owner needs permission to create/drop a temporary test database and create synthetic roles. `PSQL` can specify the psql executable. Each test database has a generated `direct_ota_test_` name and is removed afterward. The harness refuses a nonlocal host. Hosted deployment, security-advisor results, and device verification remain operator gates.
