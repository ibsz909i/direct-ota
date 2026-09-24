# Contributing

Start with a reproducible issue or a focused change. For a bug, include the runtime, platform, provider, relevant versions, expected behavior, and sanitized logs. Use synthetic data and freshly generated test keys.

```sh
npm ci
npm run check
```

Changes to native code also need the relevant native compile and device/emulator tests. Changes to a provider need authorization, concurrent publish, replay, immutable-upload, and failure-path coverage. A documentation-only change does not need a native rebuild.

Keep provider and app-runtime compatibility claims specific. A documented extension point is not a shipped adapter. Add setup instructions and tests with new providers or runtimes.

Preserve upstream notices and MPL-2.0 requirements. Do not commit application source, credentials, release bundles, private publishing identities, or local operational logs. See SECURITY.md for private vulnerability reporting.
