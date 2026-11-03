# Security Policy

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security problems.

Report it privately via GitHub's [private vulnerability reporting](https://github.com/QuotaGate/ClaudeSDK/security/advisories/new),
or email **`security@<TBD>`** (PLACEHOLDER — the security mailbox and domain are not yet
provisioned) with a description, reproduction steps and the affected
version. We aim to acknowledge reports within 3 business days and to agree on a disclosure
timeline with you before any fix is published.

## Supported versions

QuotaGate is pre-1.0. Only the latest published minor version of `@quotagate/sdk` receives
security fixes.

## Scope notes

- The SDK runs inside your process and sends span data (including prompt and response
  content unless `captureContent: false`) to the configured ingest endpoint over HTTPS.
- The `prompt_injection` policy rule is a regex heuristic. It catches naive injection
  attempts; it is not a security boundary against a determined attacker.
