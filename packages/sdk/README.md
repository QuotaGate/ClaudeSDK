# @quotagate/sdk

Observability spans, pre-flight policies and background export for the Anthropic TypeScript
SDK. Drop-in: `quotagate.wrap(new Anthropic())` returns a client with the same type and
behaviour as the original.

```ts
import Anthropic from '@anthropic-ai/sdk';
import { QuotaGate } from '@quotagate/sdk';

const quotagate = new QuotaGate({
  apiKey: process.env.QUOTAGATE_API_KEY,
  projectId: process.env.QUOTAGATE_PROJECT_ID,
});
const claude = quotagate.wrap(new Anthropic());
```

Version `0.1.0`. Requires `@anthropic-ai/sdk` >= 0.103.0 as a peer dependency and
Node.js 18+. See the [repository README](../../README.md) for what exists today.

MIT © Agentic Loops LLC
