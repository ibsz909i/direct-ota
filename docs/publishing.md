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

For existing scripts, `prepare`, `upload`, and `promote` remain available. If `publish` fails after preparation, it prints the retained release directory. Check `status`; then retry `upload --release DIR` and `promote --release DIR` as appropriate. A candidate is inactive until promotion. If channel status confirms the signed candidate despite a lost response, do not prepare a duplicate.

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
