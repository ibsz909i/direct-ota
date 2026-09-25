# Cloudflare provider deployment

Direct OTA can use a dedicated Cloudflare Worker, D1 database, and R2 Standard bucket while the app keeps any existing backend. Publishing commands carry short lived ES256 signatures; the Worker uses a separate secret to issue scoped upload capabilities. Anonymous phones can read signed metadata and immutable artifacts but cannot publish or upload.

## Set up the host app

For a new npm based Capacitor 8 app, preview the local setup and then run it:

```sh
npx direct-ota setup --provider cloudflare --base-url https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev --plan
npx direct-ota setup --provider cloudflare --base-url https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev
```

Guided setup creates a fresh private identity, public `direct-ota.config.json`, exported `ota-service/`, ignored `.direct-ota/cloudflare-trust.json` and `.direct-ota/cloudflare-upload-secret`, and native settings. It does not create or change Cloudflare resources. For an existing Direct OTA app, preserve its installed identity and use the manual `init`/`export-provider` commands only when appropriate:

```sh
npx direct-ota init --app-id app.example.demo --base-url https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev --provider cloudflare
npx direct-ota export-provider --provider cloudflare --out ./ota-service
```

The `--base-url` must be the exact stable HTTPS origin the devices will contact. Changing it or the native public key after users install the app requires a native release. Do not use a temporary `workers.dev` hostname for production.

## Deploy an isolated service

1. Sign in with Wrangler to the intended Cloudflare account. Check that R2 is enabled and that the account's Workers, D1, and R2 limits and billing settings fit your rollout. Do not reuse an app's production database or bucket.
2. Choose unique names for the Worker, D1 database, and R2 bucket. In `ota-service/`, replace `direct-ota-example` and `REPLACE_WITH_D1_DATABASE_ID` in `wrangler.jsonc`. The `DB` and `ARTIFACTS` binding names must stay unchanged.
3. Create the dedicated database and bucket, then apply the reviewed migration to the exact D1 database:

```sh
cd ota-service
npx wrangler d1 create YOUR_D1_NAME
npx wrangler r2 bucket create YOUR_R2_BUCKET --storage-class Standard
npx wrangler d1 migrations apply DB --remote
```

Record the D1 UUID printed by the create command in `wrangler.jsonc` before applying migrations. The migration creates only the OTA tables, indexes, triggers, and audit history in that dedicated database. Never apply it to an existing application database.

4. From the host app directory, set the Worker secrets. The trust file contains public keys and URLs only. The upload secret contains 32 random bytes encoded as base64. Neither is the publishing identity.

```sh
cd ota-service
npx wrangler secret put OTA_TRUST_JSON < ../.direct-ota/cloudflare-trust.json
npx wrangler secret put OTA_UPLOAD_SECRET < ../.direct-ota/cloudflare-upload-secret
npx wrangler deploy
```

If using manual `init`, create the public trust file from `direct-ota.config.json` and generate the HMAC secret securely, for example `openssl rand -base64 32 | tr -d '\n'` into a mode 0600 ignored file. Do not paste the secret into source, shell history, or a deployed app. The `OTA_TRUST_JSON` artifact base must end with `/artifacts` on this Worker's exact HTTPS origin. Do not put the EC/RSA private identity into Worker secrets.

5. Run `direct-ota status --platform ios|android` and `direct-ota doctor --remote --platform ios|android` from the host app. An empty channel should report reachable metadata. Publish a synthetic internal release, confirm a full byte hash and `206` range response, then verify installation and startup on the actual target devices before production assignment.

The exported Worker only accepts signed commands on `/publish`. Each command's nonce is consumed in D1 and is subject to a 60 per minute publisher window. Upload capabilities travel in a request header rather than a URL and bind path, hash, byte count, release ID, and expiry. Do not log that header. R2 writes are create only. Promotion rechecks the stored object's actual SHA-256 and uses a D1 conditional channel update, so competing publishers cannot silently replace a head. A signed withdrawal directly advances the channel; rollback is a newer signed instruction pointing to a previously promoted compatible artifact.

## Capacity and recovery

The Worker caches at most 256 signed channel heads for 15 seconds per isolate, coalescing refreshes. A published change can take up to 15 seconds to appear on another isolate. Checks for unknown runtimes use the same bounded catalog. This reduces D1 reads; it does not eliminate Workers request and R2 operation costs. Client checks should remain debounced and jittered. Keep a CDN or Cloudflare edge path in front of artifact delivery and monitor p95 latency, error rates, D1 reads/writes, R2 operations, storage, and Worker requests during rollout.

Cloudflare's Workers Free plan currently allows 100,000 requests per day; a fleet of 100,000 phones can exhaust that with metadata checks alone, before downloads or retries. R2 Standard has separate free operation and storage allowances, and D1 has daily limits. See the current [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), and [R2 pricing](https://developers.cloudflare.com/r2/pricing/). A large production rollout needs a measured capacity plan and may require a paid account. This template is not a promise of free delivery at fleet scale.

R2 objects, D1 releases, and channel sequences must be backed up and restored consistently. The template caps release records at 10,000 and channels at 256; it never deletes rollback artifacts automatically. An operator must review retention and capacity before those limits are approached. Disable new publishing and update offers by setting `OTA_PUBLISHER_ENABLED` to `false` and deploying the configuration. Already downloaded signed instructions remain trusted on devices; key compromise requires the native recovery in [SECURITY.md](../../SECURITY.md).

Local automated integration uses the actual Worker runtime, D1 migration, R2 binding, CLI, and HTTPS proxy. It covers signed publishing, tampered uploads, immutable writes, byte ranges, rollback, withdrawal, replay, and concurrent promotion. It does not prove the deployed Cloudflare account's quotas or a 100,000 device rollout. Test the actual deployment with an internal release and physical devices before broad promotion.
