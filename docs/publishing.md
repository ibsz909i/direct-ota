# Publishing and recovery

Run commands in the configured application directory. Use `--project DIR` when working elsewhere. The publishing identity lives in `.direct-ota/identity.json`, or in a protected file supplied with `--identity FILE`.

## A normal frontend fix

1. Review the diff and test the changed behavior. Run type checking and the production build. Keep unrelated local changes out of the release snapshot.
2. Run `npx direct-ota doctor`. It rejects native runtime drift. Native changes need a new native release.
3. Prepare and upload an internal candidate:

```sh
npx direct-ota prepare --platform ios --channel internal --version 1.0.1 --out .direct-ota/ios-1.0.1
npx direct-ota upload --release .direct-ota/ios-1.0.1
npx direct-ota promote --release .direct-ota/ios-1.0.1
npx direct-ota status --platform ios --channel internal
```

Repeat preparation for Android with its own output directory. The CLI packages the existing `webDir`; it does not secretly run your application's build or tests. A successful build must precede `prepare`.

4. On an internal app, verify download, activation, startup health, and the changed feature. Keep the publishing computer offline during a download test to prove delivery does not depend on it.
5. Promote the already-tested artifact to production. Each command creates a newer signed instruction:

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
