# Contributing to QuotaGate

Thanks for your interest in QuotaGate. This repository contains the open-source QuotaGate SDKs.

## Layout

```
packages/
  sdk/          @quotagate/sdk (TypeScript)
  sdk-python/   (planned) Python SDK
```

## Development

Requirements: Node.js 22.12+ (see `.nvmrc`). The published package itself supports Node 18+.

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

Maintainers tag `vX.Y.Z` on `main`; the `Release` workflow publishes `@quotagate/sdk` to npm
with provenance using the `NPM_TOKEN` repository secret.

By contributing you agree your contributions are licensed under the MIT License and that you
will follow the [Code of Conduct](CODE_OF_CONDUCT.md).
