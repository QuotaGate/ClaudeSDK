# Contributing to QuotaGate

This repository contains the QuotaGate SDKs. The code is proprietary to Agentic Loops LLC.
We do not accept outside contributions. Only people authorised by Agentic Loops LLC may
contribute, and their contributions are governed by their agreement with Agentic Loops LLC.

## Layout

```
packages/
  sdk/          @quotagate/sdk (TypeScript)
  sdk-python/   (planned) Python SDK
```

## Development

Requirements: Node.js 22.12+ (see `.nvmrc`). The published package supports Node 22 and later;
CI tests Node 22 and Node 24.

```bash
npm ci              # install (npm workspaces)
npm run build       # ESM + CJS build into packages/sdk/dist
npm test            # vitest unit + integration tests
npm run lint        # eslint + prettier --check
npm run typecheck   # tsc --noEmit over src and tests
```

Inside `packages/sdk`, `npm run format` applies prettier and `npm run test:dist` smoke-tests
the built ESM and CJS entry points.

## Guidelines

- Tests must not call the real Anthropic API or require API keys; use the mocks in
  `packages/sdk/test/helpers.ts`.
- The SDK must never add blocking latency to an Anthropic call and must never throw into
  application code because of telemetry (capture and flush failures are logged to stderr).
- `wrap()` must stay drop-in: the wrapped client has the same type and behaviour as the
  original.
- Keep the public API small. New options need a clear use case.
- Open an issue before large changes. One logical change per pull request; CI must pass.

## Releases

1. Bump `version` in `packages/sdk/package.json` and `SDK_VERSION` in `packages/sdk/src/version.ts`.
2. Add a section to `CHANGELOG.md`.
3. Merge to `main` through a pull request.
4. A repository admin pushes the tag `vX.Y.Z`.
5. The `Release` workflow runs every check and uploads the package tarball as an artifact.
6. It then stages the release on npm through trusted publishing (OIDC). No npm token is stored.
7. A maintainer approves the staged release with npm two-factor authentication.

Tags with a hyphen, such as `v0.2.0-pilot.1`, use the `next` dist-tag instead of `latest`.

The very first npm release is published by hand, because npm trusted publishing needs the
package to exist first. The workflow detects this and skips staging.

Everyone working in this repository follows the [Code of Conduct](CODE_OF_CONDUCT.md).
