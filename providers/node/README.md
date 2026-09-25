# Direct OTA Node provider

This template launches the provider from an installed `direct-ota` package. Node 24+ is required. Keep one process per persistent data directory and put an HTTPS reverse proxy in front of it.
The export includes a `.gitignore` for local runtime state and credentials; keep it when committing the service template.

1. Install a Direct OTA 0.7.1 tarball built from this source revision in the exported directory: `npm install /path/to/direct-ota-0.7.1.tgz`. This tarball is not yet attached to a public release; the older 0.7.0 Node service still places upload capabilities in URLs.
2. Copy your **public** `direct-ota.config.json` here. Its artifact base must end in `/artifacts`, for example `https://updates.example.com/artifacts`. Do not copy `.direct-ota/identity.json` to the server.
3. Choose a private persistent data directory. Set `OTA_DATA_DIR` and, if needed, `OTA_TRUST_FILE` to the public configuration path. The default data location is outside the source tree, beneath the service user's home at `.local/state/direct-ota/<appId>/<environment>`.
4. Run `npm start`. The default listener is `127.0.0.1:8787`; `HOST` and `PORT` can override it. HTTPS terminates at your reverse proxy.
5. Route `/check`, `/publish`, `/upload`, and `/artifacts/` to this listener. Preserve Range and Content-Range. Forward the `X-Direct-OTA-Upload` header on `/upload` and redact it from proxy logs.

`start.mjs` imports `direct-ota/server` from the installed package. Do not run the copied `server.mjs` directly: its source-relative imports belong to the package layout.

Set `OTA_PUBLISHER_ENABLED=false` and restart to stop new publishing and public metadata offers. Existing downloaded signatures remain trusted on phones until a native key update; this is not device key revocation.

The process creates a 32-byte upload secret with mode 0600 in its private data directory, plus SQLite state, artifacts, and a lock file. Back up the complete directory while stopped or use a consistent SQLite/filesystem snapshot. Never put it under a public web root. After a crash, confirm no process owns the directory before removing a stale `service.lock`; restart deletes abandoned staging files.

Default limits: 1,200 requests/minute, 60 publishing requests/minute, 64 active requests, 2 uploads, 256 channel/runtime heads, 10,000 release records, 2 GiB reserved artifact storage. Limits protect this reference process; they are not a distributed denial-of-service defense or a fleet capacity claim. Add reverse-proxy admission rules and a CDN for immutable artifact responses, then measure your deployment. Optional telemetry is not implemented.

For the full API, topology and recovery guide see [Node deployment](https://github.com/ibsz909i/direct-ota/blob/main/docs/providers/node.md).
