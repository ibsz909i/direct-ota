# Direct OTA Supabase provider

Export this template using `direct-ota export-provider --provider supabase --out ./ota-service`. The export replaces the development protocol re-export with the canonical standalone protocol. Deploy the exported directory, not the unprocessed repository template.

Use a dedicated Supabase project or review the target project's existing policies first. This template creates only its `direct_ota_private` schema, `direct_ota` Storage bucket, service-only public RPCs, and restrictive bucket policies. It does not need application user accounts or business tables.

1. Install the Supabase CLI and authenticate using your usual operator workflow. Confirm the intended project before linking or applying changes.
2. Create a deployment workspace using `supabase init`. Copy this directory's `migrations/`, `functions/`, and function configuration entries into that workspace's `supabase/` directory and `supabase/config.toml`. Preserve unrelated configuration.
3. Link the correct project and review/apply the migration with `supabase db push`.
4. Edit `setup.sql` using the PUBLIC key ID, app ID, environment, artifact URL and contract from your client configuration; run it once as database owner. Publishing is denied until that enabled configuration row exists.
5. Set the Edge secret `OTA_TRUST_JSON` to your public trust configuration. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are Supabase-managed server environment variables. Never use the publisher private identity as an Edge secret. An environment file for `supabase secrets set --env-file` avoids putting values in command history; keep it outside version control.
6. Deploy `direct-ota-check` and `direct-ota-publish`, using the supplied `verify_jwt=false` entries (or `--no-verify-jwt`). The publishing function performs its own ES256 authorization, short command lifetime, audience/purpose checks, and database nonce protection. A Supabase app JWT is not publisher authorization; logged-out devices must be able to check.
7. Verify a synthetic internal release through the CLI and your target device before production. Test public read, denied unsigned publishing, scoped upload, duplicate upload rejection, actual byte/hash checking, Range download, rollback and withdrawal.

Your artifact base is `https://YOUR_PROJECT.supabase.co/storage/v1/object/public/direct-ota`. Public downloads expose distributable frontend assets. They do not authorize uploads or channel changes. Signed upload capabilities use Supabase's create-only default and the client sends `x-upsert:false`. Never log capability URLs.

The public check function refreshes one coalesced catalog of at most 256 heads every 15 seconds, independent of untrusted runtime selectors, with a five-second failure cooldown. Admission ceilings apply before request processing. Publishing is limited to 60 commands/minute at both the isolate and database level. The schema caps stored release metadata at 10,000 records and reserved distinct artifacts at 2 GiB; expired reservations count until explicitly reviewed for cleanup. Retained nonces are pruned on signed commands.

Place infrastructure admission controls ahead of the functions; each isolate's in-memory budget cannot stop a distributed attack. Storage and Edge Function quotas still apply. No fleet-scale benchmark or hosted Storage integration test is claimed. Optional telemetry is not implemented.

Full guide: [Supabase deployment](https://github.com/ibsz909i/direct-ota/blob/main/docs/providers/supabase.md).
