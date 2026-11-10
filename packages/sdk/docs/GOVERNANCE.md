# QuotaGate governance (Track B, pre-release)

This guide covers policy files, tool-call guards, audit events and violation webhooks in
`@quotagate/sdk`. The features are unreleased and live on a review branch.

## Limitations

- **No backend endpoint.** No QuotaGate service receives audit events. Events go only to
  your `onAuditEvent` callback, so storing them is up to you. QuotaGate makes no promise
  that they are stored, retained or tamper-evident.
- **Webhooks are best-effort.** They are sent from your process. The queue is in memory
  and bounded (100 by default). Pending webhooks are lost if the process exits.
- **Only guarded tools are enforced.** A tool your code runs without `guardTool` is not
  checked. `checkToolCalls` is advisory; your code must honour `allowed`.
- **Change attribution is customer-asserted.** `policyChangeContext.author` and `commit`
  are recorded as given and are not verified.
- **Rate limits are per process.** This is unchanged from the existing request rules.

## Quick start

```ts
import Anthropic from '@anthropic-ai/sdk';
import { QuotaGate, ToolCallDeniedError } from '@quotagate/sdk';

const qg = await QuotaGate.init({
  policyFile: './policies/prod.yaml', // the file is required; init() throws if it is invalid
  policyVersion: process.env.GIT_SHA, // optional: overrides the file's `version` field
  policyChangeContext: { author: 'jdoe', commit: 'a1b2c3d' }, // optional, customer-asserted
  agentId: 'payments-agent',
  webhook: {
    url: process.env.QUOTAGATE_WEBHOOK_URL!, // must be https://
    secret: process.env.QUOTAGATE_WEBHOOK_SECRET!, // at least 16 characters
  },
  onAuditEvent: (event) => auditStore.append(event), // the only place events go
  onHumanReview: async (review) => ((await askReviewer(review)) ? 'approve' : 'deny'),
});

const claude = qg.wrap(new Anthropic());
const initiateTransfer = qg.guardTool('payments', async (input: TransferInput) =>
  bank.transfer(input),
);

try {
  await initiateTransfer(toolUse.input as TransferInput, { sessionId: runId });
} catch (err) {
  if (err instanceof ToolCallDeniedError) {
    // err.disposition: 'block' | 'error_blocked' | 'escalated'; err.ruleId; err.eventId
  }
}
```

`init()` always runs in metadata-only mode. Passing `captureContent: true` or inline
`policies` throws an error. Declare request-level rules under `request_rules` in the
file instead, so that they are hashed and versioned with it.

## Policy file

The file is YAML 1.2. JSON is also accepted, because it is valid YAML 1.2. Worked
examples are in `examples/policies/fintech.yaml` and `examples/policies/legaltech.yaml`.

```yaml
version: '1.2.0'
rules:
  - id: transfer_limit # snake_case and unique; recorded as rule_id
    description: 'Transfers over $5,000 need human approval.'
    action_patterns: # patterns are ORed
      - type: tool_call
        tool: payments # exact name, or '*'
        method: initiate_transfer # read from input.method by default
        # method_field: op.name    # optional dot path for another field
        param_conditions: # keys and operators are ANDed
          amount: { gt: 5000 }
          beneficiary.country: { not_in: [US, CA] }
    disposition: require_human_review # block | warn | require_human_review
    escalate_to: compliance_webhook # optional; included in the webhook payload
request_rules: # optional; same shape as the existing request policies
  - type: pii_detection
    params: { patterns: [credit_card], action: warn }
```

The available operators are `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `not_in`,
`matches` and `exists`. `matches` takes a regex and tests string values only.

The loader rejects all of the following:

- unknown fields
- duplicate rule IDs or duplicate YAML keys
- unknown operators and operands of the wrong type
- invalid regex
- unsafe dot paths (`__proto__`, `prototype`, `constructor`, empty segments)
- files over 1 MiB

Each error names the file, line, column and field. Error messages never quote file
contents.

## How tool calls are evaluated

| Situation                                                                            | Result                                                        |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| No rule matches                                                                      | `pass`: the tool runs                                         |
| A `warn` rule matches                                                                | `warn`: the tool runs and a webhook is sent                   |
| A `block` rule matches                                                               | `block`: the tool does not run                                |
| A `require_human_review` rule matches                                                | `escalated`: runs only if `onHumanReview` returns `'approve'` |
| A constrained parameter is missing or the wrong type, or the method field is missing | `error_blocked`: the tool does not run                        |
| The evaluator throws                                                                 | `error_blocked`: the tool does not run                        |

Rules are fail-closed: a parameter that cannot be evaluated never lets a prohibited
action through. For example, an `amount` sent as the string `"6000"` is denied when the
rule checks `gt: 5000`.

A pattern stops applying as soon as one of its conditions is definitely false. For
example, a valid `amount: 10` means a `gt: 5000` rule does not apply.

When several rules match, the strictest result wins, in this order: `block`,
`error_blocked`, `escalated`, `warn`, `pass`.

Dot paths read only the object's own properties on plain objects. They never follow the
prototype chain and never index into arrays.

The human-review call is denied in these cases:

- no reviewer is configured
- the reviewer throws an error
- the reviewer returns anything other than `'approve'`
- the reviewer exceeds `humanReviewTimeoutMs`

## Audit events (metadata only)

The SDK emits these event types: `policy_activated`, `policy_load_failed`,
`request_evaluated`, `tool_call_evaluated`, `review_resolved` and `webhook_delivery`.
Each event carries these fields:

- `event_id` (UUIDv7)
- `policy_hash`, the SHA-256 of the raw file bytes, which you can check with `sha256sum`
- `policy_version` and `rule_version`
- `rule_id` and `matched_rule_ids`
- `tool_name`
- `tool_method`, reported only when it equals a method declared in the policy
- `param_names`, the top-level keys only
- `disposition` and `latency_ms`

Events never contain any of the following:

- prompts, system prompts or responses
- tool input values
- free-form `metadata`
- error message text

`action_payload_hash` is an HMAC-SHA256 of the canonical input when you set
`payloadHashKey`. Otherwise it is `null`; a plain hash is never used, because plain
hashes can be guessed.

`policy_activated` is emitted on every `init()`. No server exists to deduplicate
activations by hash.

In init mode, exported spans (when `apiKey`, `projectId` and `endpoint` are set) carry:

- no message or response content and no tool inputs
- empty `metadata`
- an error class label instead of error text, e.g. `Error (HTTP 500)`

Ingest rejection logs show counts only.

## Violation webhooks

A webhook is sent for every non-`pass` result, for both tool rules and request rules.
The payload follows PRD Feature 3 and adds `event_id`, `matched_rule_ids`, `agent_id`,
`policy_hash`, `escalate_to` and `delivery_attempt`.

`action_summary` lists the tool name, method and parameter names, but never values. For
example: `account_management.close_account called with [account_id, method]`.

Each request carries these headers:

```
QuotaGate-Event-Id: <event_id>
QuotaGate-Timestamp: <unix seconds>
QuotaGate-Signature: v1=<hex HMAC-SHA256(secret, timestamp + "." + raw_body)>
```

To verify a webhook on the receiving side:

1. Compute the signature over the raw body.
2. Compare it in constant time.
3. Reject timestamps older than five minutes.
4. Deduplicate on `event_id`, because a retry carries the same id.

Delivery makes three attempts in total: immediately, then after 2 s and after 8 s. Each
retry adds up to 0.5 s of jitter, and each attempt times out after 5 s.

- **Retried:** network errors, timeouts, 408, 429 and 5xx responses.
- **Not retried:** other 4xx responses.
- **Not followed:** redirects.

Each outcome is reported as a `webhook_delivery` audit event: delivered, failed or
dropped. The agent is never blocked by webhook delivery.

Delivery logs contain only the event id, attempt count, HTTP status and the URL's scheme
and host. They never contain bodies, response text, query strings or the secret.

### Slack and PagerDuty

Neither service accepts arbitrary signed JSON directly. Run a small relay that does the
following:

1. Verify the signature.
2. For Slack, post `rule_id`, `disposition` and `action_summary` to an incoming-webhook URL.
3. For PagerDuty, send an Events API v2 `trigger` with `dedup_key = event_id`.

## Compatibility impact: `captureContent` now defaults to `false`

`new QuotaGate({...})` used to capture prompts, responses and tool inputs on spans by
default. It no longer does. To keep the old behaviour, set `captureContent: true`.

Spans still carry the model, token usage, latency, stop reason, tool names and policy
checks. `QuotaGate.init()` always uses `false`.
