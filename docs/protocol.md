# Provider contract, version 1

The canonical field validation and signature verification live in `src/protocol.ts`. The supplied providers use that module. Port its validation and tests with any new provider; do not trust client-supplied fields before verification.

## Public check

`POST checkUrl` with JSON `{ "platform": "ios", "channel": "internal", "runtime": "<64 lowercase hex characters>" }`.

Return `{ "manifest": "<compact JWS>" }` or `{ "manifest": null }`. No login or application account is required. This endpoint exposes no customer information. Bound request sizes, reject unknown fields, and do not create a row for every check or unknown runtime. Use a small bounded catalog cache; metadata responses use `Cache-Control: no-store`.

## Signed publishing commands

`POST publishUrl` with `{ "command": "<compact JWS>" }`.

The protected header is exactly `{alg: "ES256", typ: "DIRECT-OTA-PUBLISH", kid: "<trusted key ID>"}`. Payload fields:

| Field | Meaning |
| --- | --- |
| protocol | `1` |
| appId | Pinned application identifier |
| aud | `direct-ota-publish` |
| action | `status`, `reserve`, or `promote` |
| iat / exp | Integer Unix seconds, at most 60 seconds apart |
| nonce | Fresh UUID; atomically consumed by the server |
| body | Action-specific object |

Verify the trusted publisher key, signature, audience, time bounds, exact field sets, and nonce before mutation. Retain nonces beyond the acceptance window, prune expired records, and rate-limit before writing them. Transport retries must sign a fresh command and nonce.

### status

Body is the selector `{platform, channel, runtime}`. Return `{sequence, manifest}`; sequence is zero and manifest null for a new channel.

### reserve

Body `{manifest: "<signed release JWS>"}`. The server verifies the nested manifest, reserves exactly its immutable artifact path, and returns:

```json
{
  "releaseId": "<UUID>",
  "uploadRequired": true,
  "upload": {"url": "<approved HTTPS upload URL>", "method": "PUT", "headers": {"<provider-specific header>": "<value>"}}
}
```

`uploadRequired: false` means the provider found a candidate object at the immutable path. The Node provider verifies bytes when reserving; the Supabase provider checks object metadata at reservation. Every promotion must verify actual bytes and hash before activation. Reservations do not activate releases. Upload capabilities authorize one path, expire, and cannot overwrite existing objects. Never log capability URLs or headers. The Cloudflare provider places its capability in a request header to avoid URL logging. The CLI permits only configured HTTPS upload origins and rejects redirects.

### promote

Body `{manifest: "<signed release or withdrawal JWS>", expectedSequence: 12}`. For a release, verify the artifact's actual bytes/hash and the reservation. A signed withdrawal has no artifact and needs no reservation. Then atomically advance that channel only if its current sequence equals `expectedSequence`. The new sequence must be exactly `expectedSequence + 1`. Return `{sequence, releaseId}`.

A conflict is HTTP 409. Do not silently retry with a new expected sequence or override another publisher. Inspect the latest channel, prepare a new instruction, and promote intentionally. A retry of an already applied identical instruction should return its successful result.

## Release manifest

The protected header uses `typ: "DIRECT-OTA"` and the pinned ES256 key. The payload binds `protocol`, `appId`, `environment`, `platform`, `channel`, `sequence`, `runtime`, `backendContract`, `action`, `rollout`, `releaseId`, `version`, and `issuedAt`.

`action: "release"` additionally includes `artifact`: immutable path and HTTPS URL, SHA-256 of the encrypted bytes, byte size, expanded size, file count, and the pinned Capgo format's checksum/session key. A release may include signed `mode: "background"`; absent or `"required"` preserves the mandatory behavior. Background updates download on Wi-Fi without blocking and activate when a new app process starts. A rollback instruction is always required. `action: "withdraw"` has no artifact or mode. See the TypeScript types for exact formats and bounds.

Paths are `platform/runtime/original-release-UUID/ciphertext-sha256.zip`. URL must equal the native-pinned artifact base plus that path. A rollback uses a new sequence and instruction UUID while retaining the previously promoted artifact path.

Default limits: 5 MiB encrypted archive, 25 MiB expanded content, 1,000 files, 8 KiB compact manifest. A native build may pin larger `limits` in `direct-ota.config.json`: `archiveBytes` up to 50 MiB, `unpackedBytes` up to 100 MiB, and `files` up to 5,000. All three values are required together, and cannot be below the defaults. The same pinned values must be deployed as provider trust and compiled into the native plugin settings; a web update cannot raise them. Archive entries must be regular files with canonical NFC names, at most 1,024 UTF-8 bytes and 32 path segments. Empty, dot, parent, absolute, control-character, colon, and backslash path components are rejected, as are links and duplicate names. API limits must be enforced independently of JavaScript checks.

## Artifact transport

Support `GET`, `HEAD`, and validated single byte ranges with stable content length and an immutable ETag. A complete file may be cached long-term. Never expose staging or partial files. The downloader validates resumed offsets and lengths, restarts safely when range support is absent, and hashes the completed artifact before installation.

The reference endpoints serve distributable bundles publicly. An alternative access model needs a compatible client/protocol design; inserting expiring query strings into signed immutable artifact URLs breaks the current contract.

## Errors and telemetry

Use bounded JSON errors without stack traces, database details, credentials, or account information. Recommended statuses: 400 malformed input, 401/403 invalid authorization, 409 sequence/artifact conflict, 413 size limit, 429 admission limit, 503 temporary failure.

Telemetry is optional. It must never authorize a release or automatic server rollback. Treat reports as untrusted, avoid account identifiers and transaction content, bound event sizes, and rate-limit collection. The supplied core works without an events endpoint.

The optional event body contains a promoted `releaseId`, an allowed event name, and optionally `metrics` with bounded nonnegative `durationMs`, `bytes`, `retries`, and `connection` (`wifi`, `cellular`, or `unknown`). The coordinator reports download attempt duration and the native received-byte progress; resumed partial bytes can already be included, so this is not an egress meter. The ready event measures time from coordinator startup. Event collectors aggregate these values and never retain installation identifiers. Success reports use a deterministic 1% device sample; failure reports are unsampled. Neither set can establish a trustworthy eligible-installation count or a verified success rate.
