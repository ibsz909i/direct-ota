# Signing-key rotation

Direct OTA can pin up to four release-signing keys in one native build. The first key stays active while the next key is staged. A native app accepts instructions from its pinned keys in order and remembers the highest key index it has accepted. Once it accepts an instruction signed by a newer key, it rejects future instructions signed by older keys. Publisher commands always require the one active key configured on the service.

## Planned rotation

1. Back up the current private identity. Run `direct-ota key-stage` in the host app. It appends a new public key to `direct-ota.config.json` and creates a private `.direct-ota/identity-<key-id>.json` with mode `0600`. It does **not** switch the publisher or contact the service. Back up this new identity separately.
2. Run `direct-ota native`, merge the generated Capacitor settings, `npx cap sync`, and `direct-ota doctor`. Build and distribute a native store release for **each** platform. Verify that the installed build pins both keys and can still receive an internal release signed by the current key. The new key ring changes the native runtime fingerprint.
3. Wait until the native builds that should continue receiving OTA releases have the new key ring. Older native builds trust only the old key and cannot verify a new-key instruction. Keep their old-key channels available or require their store update before switching the service.
4. Run `direct-ota key-activate`. It verifies the local native runtime and both synced native projects, then switches the **local** active publisher to the next key. This is not proof that store users installed the new build and it does not update any remote service.
5. Update the deployed provider's public `OTA_TRUST_JSON` to the new active `keyId` and `publicJwk`, preserving the exact ordered `trustedKeys` ring. For Supabase, also review and update `direct_ota_private.configuration.key_id` from the expected old ID to the new ID with a constrained `WHERE singleton AND key_id = '<expected-old-id>'`. Do not change release rows, artifact paths, balances, or application auth. Node's dedicated data directory accepts this staged-key switch; Cloudflare and Firebase use their usual reviewed secret deployment.
6. Publish a small **internal** release signed by the new key. Verify the signed metadata, device download, startup health, and rollback on both platforms before production promotion. A rollback after rotation must be a **new** instruction signed by the new key that points to the earlier immutable artifact; replaying the old signed instruction is rejected.

The private bundle-decryption key stays the same during this signing-key rotation. Changing it requires a separate native and bundle migration plan. Never copy a private signing key into public configuration, a native build, or an Edge secret.

## Compromise or key loss

Disable publishing and stop promotion immediately. Planned rotation is not instant fleet-wide revocation: devices that have not yet accepted a new-key instruction still trust the old key, and an attacker with the old private key may race a valid instruction if the delivery service is also compromised. Use a native store release with fresh trust and a safe bundled app for urgent compromise recovery. Restore a lost private key only from an encrypted backup; do not bypass signature checks or lower the remembered key epoch.
