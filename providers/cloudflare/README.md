# Direct OTA Cloudflare provider

This Worker uses D1 for signed release state and R2 Standard storage for encrypted update archives. It works with any application backend; the app's accounts and data are not stored here. The public `/check` and `/artifacts/*` routes do not grant write access.

Export this template with `direct-ota export-provider --provider cloudflare --out ./ota-service`, or use guided setup for a new Capacitor 8 host. The export copies the canonical protocol into `src/protocol.ts`; do not deploy the development re-export in this repository.

Read [the Cloudflare deployment guide](https://github.com/ibsz909i/direct-ota/blob/main/docs/providers/cloudflare.md) before deploying. In short: choose a unique Worker/D1/R2 name, create only those resources, put the public trust JSON and a private random upload secret into Worker secrets, apply the D1 migration, and deploy. Edit `wrangler.jsonc` with the actual D1 UUID and R2 bucket name. The template's placeholder UUID is intentionally unusable for deployment.

The publishing identity stays on the Mac or in a protected CI secret store. Never put its private EC or RSA keys in Wrangler, D1, R2, or Git. `OTA_UPLOAD_SECRET` is a distinct 32-byte random HMAC key known only to the Worker. Do not log upload capability headers. `.dev.vars`, `.wrangler/`, and generated worker types are ignored.

The release protocol, native compatibility rules, and CLI are the same as the Supabase and Node providers. Keep immutable objects and D1 channel history together for rollback. A release is not active until its signed manifest is promoted with the expected sequence. Existing apps need a native build with the updater before OTA can work.
