# Publishing and recovery

Run commands in the configured application directory. Use `--project DIR` when working elsewhere. The publishing identity lives in `.direct-ota/identity.json`, or in a protected file supplied with `--identity FILE`.

## A normal frontend fix

1. Review the diff, test the changed behavior, and run the app's type check if available. Keep unrelated local changes out of the release snapshot.
2. Publish an internal candidate:

```sh
npx direct-ota publish --platform ios --version 1.0.1
npx direct-ota doctor --remote --platform ios
```

Repeat `publish` for Android. The command runs the host app's `npm run build`, checks the native runtime, prepares the existing `webDir`, uploads, promotes to **internal**, and checks the resulting channel head. It never runs tests automatically and never promotes production. `doctor --remote` reads the deployed public endpoint, verifies the signed instruction and complete artifact hash, and checks byte-range delivery. A remote diagnostic does not prove activation or startup on a device.

`prepare` also signs a local `provenance.jws` that binds the manifest and artifact hash to the source commit, whether the Git worktree was dirty, and the build time. This file stays in the ignored release directory; it is not device metadata or proof that CI ran. Use `direct-ota inspect --release DIR` to verify it and see the artifact ID separately from the release ID. `direct-ota history --platform ios --limit 20` pages through locally retained, signed candidate directories. `history --remote --platform ios --limit 20` pages through promoted releases on the selected channel using signed publisher requests and a sequence cursor; `inspect --remote --release-id UUID` shows one promoted release. Remote history is an operational view. `status` remains authoritative for the live channel.

To rotate the release signer, use [the staged native key procedure](key-rotation.md). `key-stage` changes the native trust fingerprint; `key-activate` changes only the local active identity after native sync checks. Update the provider's active public key and prove an internal release before production use.

For existing scripts, `prepare`, `upload`, and `promote` remain available. If `publish` fails after preparation, it prints the retained release directory. Check `status`; then retry `upload --release DIR` and `promote --release DIR` as appropriate. A candidate is inactive until promotion. If channel status confirms the signed candidate despite a lost response, do not prepare a duplicate.

For a routine frontend change, `publish --mode background` signs a release that downloads silently on Wi-Fi and activates on the next app process start. The default is required. A background release never begins a cellular transfer, even if the user previously consented for another required update. The mode is carried through staged rollout; rollback uses required mode. This signed field needs the new native integration. Older installed runtimes cannot be sent a background-mode manifest; keep their compatible release path until they receive a store build.

For an app with the current delta-capable native integration, prepare a smaller update against a retained candidate on the same native runtime:

```sh
npx direct-ota prepare --platform ios --version 1.0.2 --delta-from .direct-ota/releases/PRIOR_RELEASE_ID --out .direct-ota/releases/NEW_RELEASE_ID
npx direct-ota upload --release .direct-ota/releases/NEW_RELEASE_ID
npx direct-ota promote --release .direct-ota/releases/NEW_RELEASE_ID
```

The CLI includes a delta only when both plaintext ZIPs are at most 5 MiB, the encrypted patch is smaller than the encrypted full ZIP, and the combined immutable object stays within the native-pinned archive limit. Otherwise it publishes a normal full bundle. Retain the previous candidate directory and its private bundle identity to prepare a delta. A phone without the matching cached base downloads the signed full segment; a corrupt patch falls back to that segment. Both paths verify the final plaintext ZIP and archive bounds before import. The signed delta field requires a new native store build; old runtimes remain on their own compatible channel.

3. On an internal app, verify download, activation, startup health, and the changed feature. Keep the publishing computer offline during a download test to prove delivery does not depend on it.
4. Promote the already-tested artifact to production. Each command creates a newer signed instruction. Use the release directory returned by `publish`:

```sh
npx direct-ota rollout --from .direct-ota/ios-1.0.1 --platform ios --channel production --rollout 1
# Inspect health and the changed feature before each next stage.
npx direct-ota rollout --from .direct-ota/ios-1.0.1 --platform ios --channel production --rollout 5
npx direct-ota rollout --from .direct-ota/ios-1.0.1 --platform ios --channel production --rollout 25
npx direct-ota rollout --from .direct-ota/ios-1.0.1 --platform ios --channel production --rollout 100
```

The CLI never advances these stages automatically. Use the same staged procedure for Android. Stable native installation cohorts determine eligibility.

Cloudflare and Firebase can optionally stop a manually requested stage when their opt-in event collector has too little sampled startup evidence or has reported failures. After the first 1% production stage, use `--health-gate --gate-min-ready 10 --gate-max-failures 0` on each `rollout` command. A gated command requires the current production instruction to use the same artifact and moves only 1→5→25→100. A failed or unavailable health request stops promotion; it never withdraws or rolls back a release. Device events are untrusted and a successful gate does not establish release safety. Keep manual device and core-flow review at each stage. Node and Supabase do not currently collect these events, so this gate is unavailable for those providers.

## Conflicts and retries

The CLI retries transient metadata/upload failures a bounded number of times. Publishing commands get a fresh nonce each attempt. A channel conflict remains visible; check `status` and prepare a fresh instruction. Do not edit a signed manifest or overwrite its archive.

If upload is interrupted, run `upload` again. The immutable candidate is inactive until promotion. Device downloads have their own persistent resumption, offline handling, cellular consent, and retry behavior; a publisher retry is not the same as a device retry.

## Withdraw

```sh
npx direct-ota withdraw --platform ios --channel production
```

Withdrawal stops offering that channel's release. It does not erase already installed copies or restore a previous app. Publish a rollback instruction when installed users need to return to an earlier compatible artifact.

## Roll back

Retain release directories and server artifacts for known-good versions. Point to a previously promoted compatible release:

```sh
npx direct-ota rollback --from .direct-ota/ios-1.0.0 --platform ios --channel production
```

Rollback increments the channel sequence. Never move the database sequence backwards or change an old artifact in place. Native startup rollback can recover a failed launch, but cannot detect every problem encountered later in the app.

## What to record

Record app/environment, platform/channel, sequence, release ID, artifact hash, source commit, version, and the verification performed. Keep upload capabilities and private keys out of the record. Distinguish uploaded, promoted, downloaded, activated, and healthy; each is a different result.

For a package maintainer release, `npm run release:verify -- --out .direct-ota/release-artifacts` requires a clean checkout, runs the checks and dependency audit, creates the npm tarball and SHA-256 file, installs it in a disposable consumer, and smokes the CLI and exports. Review the resulting digest before attaching the files to a GitHub Release. npm registry publication requires a separately authenticated maintainer account.
