# Compatibility and adaptation

There are two independent choices: the **app runtime**, which installs an update, and the **backend**, which serves it.

## App runtime

| App | Included path |
| --- | --- |
| Capacitor 8 + web frontend | Native overlay and JavaScript coordinator |
| React, Vue, Angular, Svelte, or plain HTML inside Capacitor 8 | Same integration; framework is not part of the protocol |
| Older/newer Capacitor major | Port and test the pinned native integration first |
| React Native / Expo | Use a runtime-compatible updater or implement and verify an adapter |
| Flutter | No included runtime adapter |
| Pure Swift / Kotlin | Native executable changes require a new native release; this web-bundle updater cannot replace them |
| Web/PWA | Use the web deployment and service-worker lifecycle appropriate to that app |

An agent can adapt code; that does not make an unimplemented adapter production-ready. A new runtime adapter needs signature and compatibility validation before execution, approved-host downloads, persistent resumption, archive safety, protected-action coordination, health reporting, and rollback. Define and test those behaviors before advertising support.

## Backend

The update service does not need access to application users, sessions, balances, or business tables. You can:

1. Add the supplied Node service beside an existing API.
2. Create a Supabase project only for OTA, keeping the app's existing backend.
3. Implement the same HTTP contract in another stack.

A provider is ready only when its authorization, immutable uploads, replay prevention, atomic promotion, and actual artifact validation pass the contract tests. Storing a ZIP in a bucket is only one part of the job.

## Native runtime and backend contracts

The runtime fingerprint binds the release to the native inputs recorded by the integration. Recompute and review those inputs whenever native dependencies or configuration change. Do not exclude a native file merely to make `doctor` pass.

`backendContract` is a separate compatibility value. Deploy additive server support before a frontend that needs it, and keep old behavior while supported native builds or retained rollback bundles need it. Local data migrations must also remain readable by retained rollback versions.

## Cost

The project has no license subscription or per-user fee. Providers can still charge for storage, compute, and downloads. Supabase offers a [free plan with quotas](https://supabase.com/pricing); check current limits and inactivity behavior before depending on it for production delivery.
