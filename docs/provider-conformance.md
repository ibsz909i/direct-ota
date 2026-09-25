# Provider SDK and conformance

`create-provider` copies the canonical TypeScript protocol, signed HTTP admission layer, telemetry schema, and a minimal adapter entry point into a new directory. The scaffold is **not** a deployable server. Implement `ProviderAdapter` with your backend's atomic transactions and immutable object storage; expose `provider.fetch(request)` over HTTPS. The SDK validates signatures, purpose, manifest shape, request size, and selector shape. The adapter still owns atomic replay prevention, reservation, object hash checks, channel compare-and-swap, HEAD/range delivery, and storage authorization.

```sh
npx direct-ota create-provider --name my-backend --out ./ota-provider
npx direct-ota test-provider
npx direct-ota test-provider --write
```

The first test is read-only. Write mode creates a random synthetic native runtime, signs a release, tests tamper and replay rejection, uploads an encrypted ZIP, verifies full/range delivery, races two promotions, rolls back, and withdraws the synthetic channel. **Use an isolated service for write mode:** it still writes release records, artifacts, and audit history. Passing tests proves the observed contract under the test conditions. It does not prove live billing, quotas, large-fleet load, device installation, or every failure mode.

The Firebase emulator and Cloudflare local Worker integration tests run this same conformance function. Keep the source copied by `export-provider` in sync with the package. If the protocol changes, test all supported providers before shipping.
