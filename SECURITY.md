# Security

## Reporting a vulnerability

Use this repository's GitHub **Security → Report a vulnerability** option for a private report. Include the affected version, prerequisites, reproduction, and impact with synthetic data. Do not post credentials, live customer data, or an active exploit against someone else's deployment in a public issue.

## Trust model

A publishing identity has two private keys: an ES256 manifest/command key and the RSA key used by the pinned Capgo bundle format. The CLI generates fresh keys; it does not ship a shared identity. The installed native app pins public trust configuration.

Only signed, short-lived publishing commands can reserve and promote releases. Servers reject replayed nonces. Promotion checks the actual artifact hash and size, then conditionally replaces the expected channel sequence. Devices independently verify the signed instruction and bundle before activation.

The default local identity is a mode-0600 file in an ignored directory, not an encrypted key vault. Use full-disk encryption and restricted access on the publishing machine. Keep an encrypted offline backup or supply a protected identity file through your CI secret manager. Never commit the file. A person or process that can use this identity can publish code to your users.

## What encryption does not do

Frontend code is inspectable on the device. The updater's bundle format is not a safe place for secrets. The public manifest contains the material the client needs to process the bundle; it is not a confidentiality boundary.

Public read access to distributable bundles is intentional in the supplied providers. It is separate from permission to upload or promote. Artifact URLs contain no account data, and archives must contain no secrets, source maps, or development files. Use the publishing scanner as one check, not as a guarantee that all possible secret formats are recognized.

## Server deployment

- Serve endpoints and artifacts through HTTPS. Pin stable artifact URLs in native configuration. Redirects are rejected.
- Keep database/service credentials server-side. Public app configuration contains only public verification material and endpoints.
- Preserve create-only artifact writes. Do not give ordinary application accounts permission to modify OTA storage or tables.
- Put admission limits at the reverse proxy or edge as well as in the provider. A distributed denial of service requires infrastructure protection; an in-process limit is not enough.
- Back up channel state and artifacts together. Restore sequence history without moving a live channel backwards. A rollback is a newer signed instruction pointing to an older compatible artifact.

## Key loss and compromise

If a publishing key is suspected compromised, immediately disable that publisher at the service and stop promotions. Preserve audit records, inspect channels, and issue a native release with new trust keys and a safe bundled app. An attacker who already has a signing key may have issued valid instructions; merely changing a server environment variable cannot revoke trust already pinned on every device.

If keys are lost, recover from the encrypted backup. Without that backup, distribute a new native release with a new identity. Never add a signature bypass as a recovery mechanism.

## Scope

This project has automated tests and source review, not an independent security certification. The operator remains responsible for store compliance, backend authorization, secret handling, capacity, and testing the app-specific integration. See docs/verification.md for what was actually verified.
