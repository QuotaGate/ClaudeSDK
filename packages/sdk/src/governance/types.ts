import type { PolicyRule, QuotaGateOptions } from '../types.js';

// ---------------------------------------------------------------------------
// Policy file (YAML or JSON) — PRD Track B Feature 2
// ---------------------------------------------------------------------------

export type ToolRuleDisposition = 'block' | 'warn' | 'require_human_review';

export type ScalarValue = string | number | boolean;

/** Operators allowed in `param_conditions`. Several operators on one key are ANDed. */
export interface ParamCondition {
  eq?: ScalarValue;
  ne?: ScalarValue;
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
  in?: ScalarValue[];
  not_in?: ScalarValue[];
  /** RegExp source string; tested against string values only. */
  matches?: string;
  /** true: the key must be present; false: the key must be absent. */
  exists?: boolean;
}

export interface ActionPattern {
  type: 'tool_call';
  /** Exact tool name, or `*` for any tool. */
  tool: string;
  /** Exact method name, read from `input[method_field]` (default `method`). */
  method?: string;
  /** Dot path of the input field that carries the method. Default `method`. */
  method_field?: string;
  /** Dot path of an input field -> operators. All keys must hold for the pattern to match. */
  param_conditions?: Record<string, ParamCondition>;
}

export interface ToolRule {
  id: string;
  description: string;
  action_patterns: ActionPattern[];
  disposition: ToolRuleDisposition;
  escalate_to?: 'compliance_webhook';
}

/** Validated contents of a policy file. */
export interface PolicyDocument {
  version: string;
  rules: ToolRule[];
  /** Existing request-level rules (token_budget, cost_budget, ...), evaluated before Claude calls. */
  request_rules?: PolicyRule[];
}

/** A loaded policy file plus the identifiers recorded on every audit event. */
export interface LoadedPolicy {
  document: PolicyDocument;
  /** Base name of the file (never the full path). */
  fileName: string;
  /** SHA-256 (hex) of the raw file bytes. Verifiable with `sha256sum`. */
  policyHash: string;
  /** SHA-256 (hex) of the canonical JSON of the validated document. */
  canonicalHash: string;
  /** `policyVersion` option if set, else the file's `version` field. */
  policyVersion: string;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * Outcome of a tool-call evaluation.
 * - `escalated`: a `require_human_review` rule matched (see `review_resolved` for the result).
 * - `error_blocked`: the call could not be evaluated safely (missing / wrong-type constrained
 *   parameter, or an evaluator error). Guarded execution is denied (fail-closed, decision A8).
 */
export type ToolDisposition = 'pass' | 'warn' | 'block' | 'escalated' | 'error_blocked';

export interface ToolEvaluation {
  disposition: ToolDisposition;
  /** The rule that decided the disposition; null on pass. */
  ruleId: string | null;
  /** Every rule that matched or could not be evaluated. */
  matchedRuleIds: string[];
  /** Machine-readable reason code; never contains input values. */
  reasonCode: 'no_rule_matched' | 'rule_matched' | 'condition_not_evaluable' | 'evaluator_error';
  /** Method name, only when it equals a method declared in the policy (otherwise null). */
  toolMethod: string | null;
  /** escalate_to of the deciding rule, if any. */
  escalateTo: 'compliance_webhook' | null;
  latencyMs: number;
}

// ---------------------------------------------------------------------------
// Audit events — metadata only (no prompts, responses, input values or free-form metadata)
// ---------------------------------------------------------------------------

export type AuditEventType =
  | 'policy_activated'
  | 'policy_load_failed'
  | 'request_evaluated'
  | 'tool_call_evaluated'
  | 'review_resolved'
  | 'webhook_delivery';

export interface AuditEvent {
  event_id: string;
  event_type: AuditEventType;
  occurred_at: string;
  sdk_version: string;
  session_id: string | null;
  agent_id: string | null;
  policy_hash: string | null;
  policy_version: string | null;
  /** Same as policy_version (PRD webhook field name). */
  rule_version: string | null;
  rule_id: string | null;
  matched_rule_ids: string[];
  action_type: 'tool_call' | 'model_request' | null;
  tool_name: string | null;
  tool_method: string | null;
  /** Top-level input keys only (sorted, capped). Never values. */
  param_names: string[];
  /** HMAC-SHA256 of the canonical input; null unless `payloadHashKey` is configured. */
  action_payload_hash: string | null;
  /** Tool name, method and parameter names. Never parameter values. */
  action_summary: string | null;
  disposition: ToolDisposition | null;
  reason_code: string | null;
  latency_ms: number | null;
  /** policy_activated only. Customer-asserted, not verified by QuotaGate. */
  change_author?: string | null;
  change_commit?: string | null;
  policy_file_name?: string | null;
  /** policy_load_failed only. */
  error_code?: string | null;
  /** review_resolved only. */
  review_outcome?: 'approved' | 'denied' | 'error' | 'timeout' | 'no_reviewer';
  /** review_resolved / webhook_delivery: the event this one refers to. */
  related_event_id?: string | null;
  /** webhook_delivery only. */
  delivery_status?: 'delivered' | 'failed' | 'dropped';
  delivery_attempts?: number;
  http_status?: number | null;
  /** model_request only. */
  model?: string | null;
}

// ---------------------------------------------------------------------------
// Runtime options
// ---------------------------------------------------------------------------

export interface WebhookOptions {
  /** HTTPS endpoint that receives policy_violation events. */
  url: string;
  /** HMAC-SHA256 signing secret (header `QuotaGate-Signature: v1=<hex>`). */
  secret: string;
  /** Allow a plain http:// URL (local testing only). Default false. */
  allowInsecureHttp?: boolean;
  /** Per-attempt timeout. Default 5000 ms. */
  timeoutMs?: number;
  /** Delay before attempts 2 and 3. Default [2000, 8000] ms, plus up to 500 ms jitter. */
  retryDelaysMs?: readonly number[];
  /** Maximum queued (undelivered) webhooks; extra events are dropped and reported. Default 100. */
  maxQueue?: number;
}

export interface HumanReviewRequest {
  eventId: string;
  ruleId: string;
  toolName: string;
  toolMethod: string | null;
  paramNames: string[];
  /**
   * The tool input, for the customer's own reviewer. It stays in-process: QuotaGate never
   * puts it in audit events, webhooks, spans or logs.
   */
  input: unknown;
  sessionId: string | null;
  agentId: string | null;
}

export type HumanReviewDecision = 'approve' | 'deny';

export interface PolicyChangeContext {
  /** Customer-asserted author of the policy change (recorded as-is, not verified). */
  author?: string;
  /** Customer-asserted commit of the policy change (recorded as-is, not verified). */
  commit?: string;
}

export interface ToolGuardContext {
  /** Session (trace) id recorded on the audit event. */
  sessionId?: string;
  /** Overrides the default agentId for this call. */
  agentId?: string;
}

export interface ToolCallCheck {
  toolUseId: string;
  toolName: string;
  eventId: string;
  evaluation: ToolEvaluation;
  /** false for block, error_blocked and escalated: the application must not run the tool. */
  allowed: boolean;
}

/** Options for `QuotaGate.init()` (metadata-only Track B mode). */
export interface QuotaGateInitOptions extends Omit<
  QuotaGateOptions,
  'policies' | 'captureContent'
> {
  /** Path to the YAML (or JSON) policy file. One of policyFile / policySource is required. */
  policyFile?: string;
  /** Policy source supplied in memory (e.g. from a secrets store). */
  policySource?: { text: string | Uint8Array; fileName: string };
  /** Overrides the file's `version` (e.g. a git SHA). */
  policyVersion?: string;
  /** Customer-asserted change attribution recorded on the policy_activated event. */
  policyChangeContext?: PolicyChangeContext;
  /** Default agent id recorded on audit events. */
  agentId?: string;
  /** Signed violation webhooks sent from this process to the customer's endpoint. */
  webhook?: WebhookOptions;
  /** Reviewer for `require_human_review` rules. Without it, those tool calls are denied. */
  onHumanReview?: (
    review: HumanReviewRequest,
  ) => HumanReviewDecision | Promise<HumanReviewDecision>;
  /** Optional timeout for onHumanReview; a timeout denies the call. */
  humanReviewTimeoutMs?: number;
  /**
   * Receives every metadata-only audit event. There is no QuotaGate backend endpoint for
   * these events yet: this callback is the only place they go. Persist them yourself.
   */
  onAuditEvent?: (event: AuditEvent) => void | Promise<void>;
  /** Key for `action_payload_hash` (HMAC-SHA256). Without it the hash is null. */
  payloadHashKey?: string;
  /** Content capture is always off in init mode. Passing true throws. */
  captureContent?: false;
}
