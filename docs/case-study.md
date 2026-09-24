# Case study: faster frontend delivery in a loyalty app

A mobile loyalty app needed small frontend fixes to reach test devices without rebuilding and reinstalling its native shell for each change. Its business backend was already remote. The missing piece was a controlled way to deliver the web bundle.

The integration that led to Direct OTA used Capgo's updater, signed release metadata, immutable artifacts, and a separately operated update service. The publishing computer built and uploaded releases; devices downloaded from hosted storage.

## What was exercised

A small Settings change moved the language button into the header. It was delivered over the air to an existing iPhone installation, confirmed on the device, moved back, and delivered again. Another frontend release removed decorative badges from two information pages. These changes exercised the actual publish/download/activate path without requiring a native rebuild for each visual edit.

The Android integration was tested in an emulator. An interrupted download under a 128 kbit/s link with added latency retained its partial file across force-stop and an offline relaunch. After reconnection, the partial file grew again and the update completed when connectivity improved. Cellular permission remained associated with the release.

Deliberately broken startup bundles were used to exercise the foreground startup watchdog, restoration of a working bundle, and quarantine of the failed artifact on both native platforms.

## Design lessons

- A web bundle needs an independent signature and compatibility boundary. Permission to upload is not permission to execute.
- Pausing transfers during sensitive app activity matters as much as download throughput.
- Weak connections need persistent partial files and visible retry states. A spinner alone is not recovery.
- Startup health should depend on local initialization, not an unreliable authentication request.
- A newer signed instruction can roll back to older compatible bytes without moving release history backwards.

## What this evidence does not establish

These observations come from the original app integration. Direct OTA generalizes that work into configurable tooling; its separate checks are listed in [verification.md](verification.md). The case study is not a claim that every device, backend, or application framework has been tested.

An Android emulator is not a physical Android fleet. A synthetic metadata-cache test is not a 100,000-phone load test. Startup rollback does not prove all later application behavior is correct. Each adopter still needs to verify its own native build, protected actions, provider deployment, and rollout capacity.

No account data, project credentials, device identifiers, or private release artifacts from that application are included in this repository.
