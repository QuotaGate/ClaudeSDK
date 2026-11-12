# Changelog

All notable changes to `@quotagate/sdk` are listed here. Versions follow semver.

## 0.1.1 (unreleased)

First version intended for npm. Version `0.1.0` was tagged but never reached npm.

### Licence

- The SDK is now proprietary to Agentic Loops LLC. Use requires a written agreement.
- Versions before `0.1.1` were made available under the MIT License. That earlier grant is unchanged.

### Behaviour change

- `captureContent` now defaults to `false`. Exported spans carry no prompts, responses or tool
  inputs unless you set `captureContent: true`. Earlier development builds defaulted to `true`.
- In `QuotaGate.init()` mode, content capture is always off. Passing `captureContent: true` throws.

### Added (included in the `v0.1.0` tag, first documented here)

- `QuotaGate.init()` with a YAML policy file, tool-call guards (`guardTool`, `checkToolCalls`),
  human review, metadata-only audit events and signed violation webhooks.
  See `packages/sdk/docs/GOVERNANCE.md`.

### Packaging

- Supported Node.js range is now 22 or later, matching what CI tests (Node 22 and 24).
- Source maps and declaration maps are no longer shipped in the package.
- Releases are staged on npm through trusted publishing and approved by a maintainer with 2FA.
