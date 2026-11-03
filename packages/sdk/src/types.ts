import type Anthropic from '@anthropic-ai/sdk';
import type { APIPromise } from '@anthropic-ai/sdk/core/api-promise';
import type { Stream } from '@anthropic-ai/sdk/core/streaming';
import type { MessageStream } from '@anthropic-ai/sdk/lib/MessageStream';
import type { ExtractParsedContentFromParams, ParsedMessage } from '@anthropic-ai/sdk/lib/parser';

// ---------------------------------------------------------------------------
// Per-call context
// ---------------------------------------------------------------------------

/** QuotaGate context passed as `options.quotagate` on `messages.create()` / `messages.stream()`. */
export interface QuotaGateContext {
  /** Groups multiple calls into one trace. Generated (UUID v4) when omitted. */
  traceId?: string;
  /** Explicit parent span, e.g. for a call made while handling a tool call. */
  parentSpanId?: string;
  agentId?: string;
  taskLabel?: string;
  metadata?: Record<string, unknown>;
}

/** Anthropic request options plus the optional QuotaGate context. */
export type QuotaGateRequestOptions = Anthropic.RequestOptions & {
  /** QuotaGate trace/task context. Removed before the request reaches the Anthropic SDK. */
  quotagate?: QuotaGateContext;
};

// Adds overloads to the Anthropic `Messages` resource so `{ quotagate: {...} }`
// type-checks as the second argument while the wrapped client keeps the exact
// `Anthropic` type (drop-in). The original overloads are untouched. (The SDK's
// RequestOptions interface itself lives under `internal/`, which its package
// exports map does not expose, so it cannot be augmented directly.)
declare module '@anthropic-ai/sdk/resources/messages/messages' {
  interface Messages {
    create(
      params: MessageCreateParamsNonStreaming,
      options?: QuotaGateRequestOptions,
    ): APIPromise<Message>;
    create(
      params: MessageCreateParamsStreaming,
      options?: QuotaGateRequestOptions,
    ): APIPromise<Stream<RawMessageStreamEvent>>;
    create(
      params: MessageCreateParamsBase,
      options?: QuotaGateRequestOptions,
    ): APIPromise<Stream<RawMessageStreamEvent> | Message>;
    parse<Params extends MessageCreateParamsNonStreaming>(
      params: Params,
      options?: QuotaGateRequestOptions,
    ): APIPromise<ParsedMessage<ExtractParsedContentFromParams<Params>>>;
    stream<Params extends MessageStreamParams>(
      body: Params,
      options?: QuotaGateRequestOptions,
    ): MessageStream<ExtractParsedContentFromParams<Params>>;
  }
}

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

export type PolicyRuleType =
  'token_budget' | 'cost_budget' | 'pii_detection' | 'prompt_injection' | 'rate_limit';

export type PolicyAction = 'block' | 'warn';

export type BuiltInPiiPattern =
  'ssn' | 'credit_card' | 'email' | 'phone_us' | 'date_of_birth' | 'passport_us';

export type PromptInjectionGroup =
  | 'override_instructions'
  | 'role_hijack'
  | 'system_prompt_exfil'
  | 'fake_delimiters'
  | 'encoded_payload';

/** A custom regex pattern. `pattern` is a RegExp source string (JSON-serializable). */
export interface CustomPattern {
  name: string;
  pattern: string;
  flags?: string;
}

export interface TokenBudgetParams {
  /** Blocks/warns when `params.max_tokens` exceeds this value. */
  maxOutputTokens?: number;
  /** Blocks/warns when the estimated input size (~4 chars per token) exceeds this value. */
  maxInputTokens?: number;
  action?: PolicyAction;
}

export interface CostBudgetParams {
  /** Worst-case USD per call: estimated input + `max_tokens` output at model list price. */
  maxUsdPerSpan: number;
  /** Override list prices (USD per million tokens), e.g. for models the SDK does not know. */
  pricing?: { inputPerMTok: number; outputPerMTok: number };
  action?: PolicyAction;
}

export interface PiiDetectionParams {
  /** Built-in patterns to run. Default: all built-in patterns. */
  patterns?: BuiltInPiiPattern[];
  customPatterns?: CustomPattern[];
  /** Default: the policy action, else 'warn'. */
  action?: PolicyAction;
}

export interface RateLimitParams {
  /** Maximum calls allowed in the window. */
  maxCalls: number;
  windowSeconds: number;
  action?: PolicyAction;
}

export interface PromptInjectionParams {
  /** Pattern groups to disable. Default: all groups enabled. */
  disabledGroups?: PromptInjectionGroup[];
  customPatterns?: CustomPattern[];
  /** Default: 'warn' (regex heuristics have false positives; opt in to 'block'). */
  action?: PolicyAction;
}

interface RuleBase<T extends PolicyRuleType, P> {
  type: T;
  /** Optional display name used in PolicyCheck.ruleName. Defaults to the rule type. */
  name?: string;
  params: P;
}

export type PolicyRule =
  | RuleBase<'token_budget', TokenBudgetParams>
  | RuleBase<'cost_budget', CostBudgetParams>
  | RuleBase<'pii_detection', PiiDetectionParams>
  | RuleBase<'rate_limit', RateLimitParams>
  | RuleBase<'prompt_injection', PromptInjectionParams>;

export interface Policy {
  policyId: string;
  name: string;
  /** 'project' applies to every call; 'agent'/'task' match `scopeValue` against agentId/taskLabel. */
  scope: 'project' | 'agent' | 'task';
  /** agentId or taskLabel to match; null/undefined applies to all. */
  scopeValue?: string | null;
  rules: PolicyRule[];
  /** Default action when a rule triggers and the rule sets no action of its own. Default 'block'. */
  action?: PolicyAction;
  /** Default true. */
  enabled?: boolean;
  /** Present on cloud-stored policies. */
  projectId?: string;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

export interface PolicyCheck {
  policyId: string;
  ruleName: string;
  ruleType: PolicyRuleType;
  result: 'pass' | 'warn' | 'block';
  reason: string | null;
  evaluatedAt: Date;
}

export interface PolicyEvaluationContext {
  traceId?: string;
  agentId?: string;
  taskLabel?: string;
}

// ---------------------------------------------------------------------------
// Spans
// ---------------------------------------------------------------------------

export type StopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'stop_sequence'
  | 'tool_use'
  | 'pause_turn'
  | 'refusal'
  | 'error'
  | (string & {});

export interface ToolCallRecord {
  toolCallId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolResult: string | null;
  childSpanId: string | null;
}

export interface Span {
  spanId: string;
  traceId: string;
  parentSpanId: string | null;

  /** Trace-level tags, carried on every span so the backend can upsert the trace. */
  agentId: string | null;
  taskLabel: string | null;
  metadata: Record<string, unknown>;

  model: string;
  system: string | null;
  messages: Anthropic.MessageParam[];
  /** Full Anthropic response; null when the call failed or was blocked by policy. */
  response: Anthropic.Message | null;

  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  latencyMs: number;
  stopReason: StopReason;
  errorMessage: string | null;

  toolCalls: ToolCallRecord[];
  policyChecks: PolicyCheck[];

  /** false when the span was captured with `captureContent: false` (content stripped). */
  captureContent: boolean;
  streamed: boolean;

  startedAt: Date;
  completedAt: Date;
  sdkVersion: string;
}

// ---------------------------------------------------------------------------
// Client options
// ---------------------------------------------------------------------------

export interface QuotaGateOptions {
  /** QuotaGate API key. When apiKey or projectId is missing, spans are not exported (policies still run). */
  apiKey?: string;
  projectId?: string;
  /** Ingest base URL. Default is a placeholder (`https://ingest.quotagate.invalid`, domain TBD) — set this explicitly. Spans are POSTed to `${endpoint}/v1/ingest`. */
  endpoint?: string;
  /** Flush timer in ms. Default 2000. */
  flushInterval?: number;
  /** Flush as soon as this many spans are buffered. Default 100. */
  flushBatchSize?: number;
  /** Ring buffer capacity; the oldest span is dropped when full. Default 1000. */
  bufferSize?: number;
  /** What to do when the policy engine itself fails unexpectedly. Default 'log' (log and allow the call). */
  onPolicyError?: 'log' | 'block';
  /** 'silent' suppresses stderr logging of flush failures. Default 'log'. */
  onFlushError?: 'log' | 'silent';
  /** Inline policies evaluated before every call. */
  policies?: Policy[];
  /** Capture message/response content. Default true (DECISIONS D9). */
  captureContent?: boolean;
  /** Custom fetch implementation (advanced; defaults to global fetch). */
  fetch?: typeof fetch;
}
