# GitHub Actions internal publishing

Direct OTA includes a composite action at the repository root. It runs the app's build, publishes one signed **internal** release, and checks the deployed manifest, bytes, hash, and range delivery. It does not promote production or establish that a phone installed the update.

Install a reviewed Direct OTA package version in the app's lockfile. Store the contents of `.direct-ota/identity.json` as a base64 encoded GitHub environment secret named `DIRECT_OTA_IDENTITY_B64`. Never commit that file or place the identity in a workflow argument. Protect the `ota-internal` environment with the repository's usual approval rules. Pin the action to a reviewed commit SHA from the matching release rather than a moving branch.

```yaml
name: Publish internal OTA
on:
  workflow_dispatch:
    inputs:
      platform:
        type: choice
        options: [ios, android]
        required: true
      version:
        type: string
        required: true
permissions:
  contents: read
jobs:
  publish:
    runs-on: ubuntu-latest
    environment: ota-internal
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm test
      - run: npm run typecheck
      - uses: ibsz909i/direct-ota@REVIEWED_FULL_COMMIT_SHA
        with:
          platform: ${{ inputs.platform }}
          version: ${{ inputs.version }}
          identity-base64: ${{ secrets.DIRECT_OTA_IDENTITY_B64 }}
```

Change the test/typecheck commands to the app's actual scripts. The action refuses to fetch an uninstalled `direct-ota` package, stores the identity in a mode-0600 temporary file, and deletes it on exit. It requires a configured app checkout, the first native release already installed, and reachable dedicated update service. Keep the private identity out of build logs. A failed remote check after a successful publish may leave a promoted internal release; inspect `status` before retrying.

The installed app must still be tested on iOS and Android before an operator uses the separate staged production rollout commands. A scheduled or automatic production promotion is intentionally absent.
