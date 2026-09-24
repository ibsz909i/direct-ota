# Node service deployment

The standalone provider uses Node's built-in HTTP server and SQLite, with immutable files on a persistent disk. It supports one service process per data directory. It needs no access to your app's accounts, sessions, or business database.

## Install and start

After initializing the app with `--provider node`, export the template:

```sh
npx direct-ota export-provider --provider node --out ./ota-service
```

On the server, install the Direct OTA release tarball inside that exported directory and copy in only the public `direct-ota.config.json`. Run `npm start`. The template's `start.mjs` imports the installed `direct-ota/server`; the copied implementation file is not a standalone executable.

Environment options:

| Variable | Default / purpose |
| --- | --- |
| `OTA_TRUST_FILE` | `./direct-ota.config.json`, public configuration |
| `OTA_DATA_DIR` | `.local/state/direct-ota/<appId>/<environment>` beneath the service user's home |
| `HOST` | `127.0.0.1` |
| `PORT` | `8787` |
| `OTA_PUBLISHER_ENABLED` | Set `false` and restart to disable publishing and metadata offers |

The default state location is outside the repository. Keep an explicitly configured data directory outside public web roots and source control too. Never copy the private publishing identity to this service. The service creates its own random mode-0600 upload capability secret; that secret authorizes uploads, not signed releases.

## HTTPS and delivery

Terminate HTTPS at a reverse proxy and forward `/check`, `/publish`, `/upload`, and `/artifacts/` to the loopback listener. The public artifact base must end in `/artifacts`. The app pins it, so keep it stable. Preserve single byte ranges and content lengths. Do not transform or recompress encrypted artifact responses. Full artifacts use a SHA-256 ETag and immutable caching headers; only promoted files are publicly served.

Set a request body limit slightly above 5 MiB, finite timeouts, publishing admission limits, and connection ceilings at the proxy. Disable query-string logging on `/upload`; its URL carries a short-lived capability. Do not log request bodies. Public check requests require no app login; `/publish` requires the configured ES256 publisher signature.

A CDN can cache immutable artifact responses while metadata stays `no-store`. Do not cache 404/503 responses for long, and test Range behavior through the real CDN. The reference process is not a multi-region metadata service.

## Embedded server and limits

```js
import {createOtaServer} from 'direct-ota/server';
const server = await createOtaServer({
  trust: publicConfiguration,
  dataDir: privatePersistentDirectory,
  // Optional when an artifact CDN uses a different origin:
  uploadBaseUrl: 'https://updates.example.com/upload',
});
server.listen(8787, '127.0.0.1');
```

Add any different upload origin to the app project's `uploadOrigins`. The provider never follows an arbitrary artifact URL during promotion; it hashes the exact local immutable file selected by the signed path.

Default limits are 1,200 total requests/minute, 60 publish requests/minute, 64 concurrent requests, 2 concurrent uploads, 256 selector heads, 10,000 release records, and 2 GiB of reserved distinct artifact bytes. These are configurable through `limits` keys `requestsPerMinute`, `publishPerMinute`, `concurrentRequests`, `concurrentUploads`, `maxSelectors`, `maxReleases`, and `maxStorageBytes`. Adjust only after measuring your workload. Global process limits also cover downloads that reach the origin. There is no telemetry endpoint in this version.

Reservations count toward storage capacity, including abandoned candidates. There is no automatic deletion of release history or rollback bytes. Capacity exhaustion fails closed; review retention and backups before an operator changes limits or performs cleanup. Nonces expire and are pruned in bounded batches on verified commands.

## Failure and recovery

Uploads stream into private staging files, enforce signed size/hash, fsync, and link atomically into the immutable store. Partial or mismatched bytes cannot be promoted. Concurrent promotion uses a SQLite transaction and the expected channel sequence. Repeating an already current identical promotion returns success. A withdrawal is an artifact-free signed promotion and needs no reservation.

The process refuses a second owner of a data directory. After an unclean exit, verify the process is stopped before removing its stale `service.lock`. On startup, abandoned staging files are removed. Stop the service or use a consistent database/filesystem snapshot before backing up; include SQLite state, artifacts, and the upload secret. Preserve monotonic channel history on restoration. `server.close()` closes the database and releases its lock before close callbacks run.

Disabling the publisher stops new service actions; it cannot revoke valid signatures already accepted by installed native apps. Follow [SECURITY.md](../../SECURITY.md) for compromised signing keys.

## Verification

`tests/server.test.mjs` exercises real local HTTP, temporary SQLite/filesystem state, signed publishing, denied writes/replay, concurrent promotion, immutable uploads, corrupt/truncated bytes, ranged downloads, rollback, direct withdrawal, quotas, and restart persistence. The parent CLI integration test additionally exercises a trusted local HTTPS endpoint. These tests do not establish production throughput or physical-device delivery.
