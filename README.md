# QuotaGate

Operational trust for Claude agents. QuotaGate wraps the Anthropic TypeScript SDK and adds
observability spans, a pre-flight policy engine, and buffered background export, without
changing how your code calls Claude.

> Status: **pre-release (`0.1.0-dev`)**. Not yet published to npm. The hosted backend is not
> part of this repository.

## What exists today

`packages/sdk` contains `@quotagate/sdk` (MIT):

- `new QuotaGate(options).wrap(anthropic)`: returns a client with the same type as `Anthropic`.
  `messages.create()` (incl. `stream: true`), `messages.stream()` and `messages.parse()` are
  instrumented; everything else passes straight through.
- Per-call context via an extra `quotagate` request option (`traceId`, `parentSpanId`,
  `agentId`, `taskLabel`, `metadata`).
- Spans built off the hot path and flushed in the background (ring buffer of 1,000, flush
  every 2 s or 100 spans, gzip, retries with backoff). Flush failures are logged to stderr
  and never thrown into your code.
- Pre-flight policies: `token_budget`, `cost_budget`, `pii_detection`, `rate_limit`,
  `prompt_injection` (regex heuristics, warn by default). Blocking rules throw
  `PolicyViolationError` before any request is sent to Anthropic.
- Content capture is off by default: exported spans carry no prompts, responses or tool
  inputs unless you set `captureContent: true` (changed from the earlier default of `true`).
- Track B governance (pre-release, see `packages/sdk/docs/GOVERNANCE.md`): `QuotaGate.init()`
  with a YAML policy file, tool-call guards (`guardTool`, `checkToolCalls`), policy hash and
  version on metadata-only audit events, and signed violation webhooks. There is no
  QuotaGate backend for audit events yet: they go only to your `onAuditEvent` callback.
- `quotagateNoop()`: same `wrap()` shape, returns your client untouched (for tests or opt-out).

```ts
import Anthropic from "@anthropic-ai/sdk";
import { QuotaGate } from "@quotagate/sdk";

const quotagate = new QuotaGate({
  apiKey: process.env.QUOTAGATE_API_KEY,
  projectId: process.env.QUOTAGATE_PROJECT_ID,
  policies: [
    {
      policyId: "output-cap",
      name: "Output cap",
      scope: "project",
      rules: [{ type: "token_budget", params: { maxOutputTokens: 4096 } }],
    },
  ],
});

const claude = quotagate.wrap(new Anthropic());

const msg = await claude.messages.create(
  {
    model: "claude-sonnet-4-5",
    max_tokens: 1024,
    messages: [{ role: "user", content: "Hi" }],
  },
  { quotagate: { traceId: "run-42", agentId: "support-bot" } },
);
```

Without `apiKey`/`projectId`, spans are not exported but policies still run locally.
The hosted ingest domain is not yet provisioned (TBD): until it is, pass `endpoint` explicitly
when exporting (the built-in default is a non-resolving placeholder).

## Repository layout

```
packages/sdk          @quotagate/sdk (TypeScript, ESM + CJS)
packages/sdk-python   planned (Phase 2)
.github/workflows     ci.yml (lint, typecheck, build, test), release.yml (npm publish on v* tags)
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for development commands, and
[SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## License

[MIT](LICENSE) © Agentic Loops LLC
