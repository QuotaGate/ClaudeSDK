# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Email **security@getquotagate.com** with:

- a description of the problem,
- steps to reproduce it,
- the affected `@quotagate/sdk` version.

We aim to acknowledge reports within 3 business days. We will agree a disclosure timeline
with you before any fix is published.

## Supported versions

QuotaGate is pre-1.0. Only the latest published minor version of `@quotagate/sdk` receives
security fixes.

## Scope notes

- The SDK runs inside your process. Policy checks run locally and add no network call.
- Content capture is off by default. Exported spans and audit events carry metadata only:
  no prompts, responses or tool inputs. Setting `captureContent: true` adds content to
  exported spans.
- If you configure export, the SDK sends spans to the configured ingest endpoint over HTTPS.
  The built-in default endpoint is a non-resolving placeholder until the hosted service exists.
- The `prompt_injection` policy rule is a regex heuristic. It catches naive injection
  attempts. It is not a security boundary against a determined attacker.
