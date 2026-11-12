# @quotagate/sdk

Observability spans, pre-flight policies and background export for the Anthropic TypeScript
SDK. Drop-in: `quotagate.wrap(new Anthropic())` returns a client with the same type and
behaviour as the original.

```bash
npm install @quotagate/sdk @anthropic-ai/sdk
```

```ts
import Anthropic from '@anthropic-ai/sdk';
import { QuotaGate } from '@quotagate/sdk';

const quotagate = new QuotaGate({
  apiKey: process.env.QUOTAGATE_API_KEY,
  projectId: process.env.QUOTAGATE_PROJECT_ID,
});
const claude = quotagate.wrap(new Anthropic());
```

Version `0.1.1`. Requires `@anthropic-ai/sdk` >= 0.103.0 as a peer dependency and
Node.js 22 or later.

Content capture is off by default. Exported spans and audit events carry no prompts,
responses or tool inputs unless you set `captureContent: true`.

## Licence

Proprietary. Copyright © 2026 Agentic Loops LLC. All rights reserved.

Installing this package does not grant a licence. Use requires a written agreement with
Agentic Loops LLC. See the `LICENSE` file in this package.

Report security issues to security@getquotagate.com.
