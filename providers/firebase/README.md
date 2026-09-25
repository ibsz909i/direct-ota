# Direct OTA Firebase provider

Deploy this template only in a dedicated Firebase OTA project. Read [the provider guide](../../docs/providers/firebase.md) for billing, provisioning, deployment, conformance, and recovery steps. The exported copy includes the canonical protocol and provider admission source in `functions/src/`; this repository copy uses development re-exports.

`firestore.rules` and `storage.rules` deny all client access. The Admin SDK accesses dedicated OTA records and the private bucket. `OTA_TRUST_JSON` contains public keys and endpoints; `OTA_UPLOAD_SECRET` is a private HMAC key. Never deploy the local publishing identity.
