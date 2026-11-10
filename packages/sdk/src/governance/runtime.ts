import type { PolicyCheck, Span } from '../types.js';
import { isRecord, isThenable, type Logger } from '../internal/util.js';
import { SDK_VERSION } from '../version.js';
import { ToolCallDeniedError } from './errors.js';
import { ToolPolicyEvaluator } from './evaluator.js';
import { canonicalJson, hmacSha256Hex, uuidv7 } from './hash.js';
import type {
  AuditEvent,
  HumanReviewDecision,
  HumanReviewRequest,
  LoadedPolicy,
  PolicyChangeContext,
  ToolCallCheck,
  ToolEvaluation,
  ToolGuardContext,
} from './types.js';
import type { DeliveryResult, ViolationPayload, WebhookDispatcher } from './webhook.js';

const MAX_PARAM_NAMES = 50;
const MAX_NAME_LENGTH = 100;
const MAX_ID_LENGTH = 200;

export interface GovernanceOptions {
  policy: LoadedPolicy;
  agentId?: string;
  payloadHashKey?: string;
  onAuditEvent?: (event: AuditEvent) => void | Promise<void>;
  onHumanReview?: (
    review: HumanReviewRequest,
  ) => HumanReviewDecision | Promise<HumanReviewDecision>;
  humanReviewTimeoutMs?: number;
  webhook?: WebhookDispatcher;
  logger: Logger;
}

/** Tool-call governance, audit events and webhook fan-out for a QuotaGate instance. */
export class Governance {
  readonly policy: LoadedPolicy;
  private readonly evaluator: ToolPolicyEvaluator;

  constructor(private readonly opts: GovernanceOptions) {
    this.policy = opts.policy;
    this.evaluator = new ToolPolicyEvaluator(opts.policy.document.rules);
  }

  get webhook(): WebhookDispatcher | undefined {
    return this.opts.webhook;
  }

  /** Receives webhook delivery outcomes and records them as audit events. */
  onDeliveryResult(r: DeliveryResult): void {
    this.emit({
      ...this.base('webhook_delivery', null, null),
      related_event_id: r.eventId,
      delivery_status: r.status,
      delivery_attempts: r.attempts,
      http_status: r.httpStatus,
    });
  }

  policyActivated(change: PolicyChangeContext = {}): void {
    this.emit({
      ...this.base('policy_activated', null, this.opts.agentId ?? null),
      policy_file_name: this.policy.fileName,
      change_author: clip(change.author, MAX_ID_LENGTH),
      change_commit: clip(change.commit, MAX_ID_LENGTH),
    });
  }

  /** Evaluates one tool call without running anything. */
  evaluate(toolName: string, input: unknown): ToolEvaluation {
    return this.evaluator.evaluate(toolName, input);
  }

  guardTool<I, R>(
    toolName: string,
    executor: (input: I, context?: ToolGuardContext) => R | Promise<R>,
  ): (input: I, context?: ToolGuardContext) => Promise<Awaited<R>> {
    if (typeof toolName !== 'string' || !toolName)
      throw new TypeError('guardTool: toolName is required');
    if (typeof executor !== 'function')
      throw new TypeError('guardTool: executor must be a function');
    return async (input: I, context?: ToolGuardContext): Promise<Awaited<R>> => {
      const sessionId = clip(context?.sessionId, MAX_ID_LENGTH);
      const agentId = clip(context?.agentId, MAX_ID_LENGTH) ?? this.opts.agentId ?? null;
      const evaluation = this.evaluator.evaluate(toolName, input);
      const event = this.toolEvent(toolName, input, evaluation, sessionId, agentId);
      this.emit(event);
      this.notify(event, evaluation);

      const denied = (disposition: 'block' | 'error_blocked' | 'escalated') =>
        new ToolCallDeniedError({
          toolName,
          disposition,
          ruleId: evaluation.ruleId,
          matchedRuleIds: evaluation.matchedRuleIds,
          reasonCode: evaluation.reasonCode,
          eventId: event.event_id,
        });

      if (evaluation.disposition === 'block' || evaluation.disposition === 'error_blocked') {
        throw denied(evaluation.disposition);
      }
      if (evaluation.disposition === 'escalated') {
        const approved = await this.review(event, evaluation, toolName, input, sessionId, agentId);
        if (!approved) throw denied('escalated');
      }
      return (await executor(input, context)) as Awaited<R>;
    };
  }

  /**
   * Evaluates every `tool_use` block in a Claude response. Advisory: the application must
   * honour `allowed`. `require_human_review` blocks are reported as not allowed; use
   * guardTool to run the review flow.
   */
  checkToolCalls(message: unknown, context: ToolGuardContext = {}): ToolCallCheck[] {
    const content = isRecord(message) && Array.isArray(message.content) ? message.content : [];
    const sessionId = clip(context.sessionId, MAX_ID_LENGTH);
    const agentId = clip(context.agentId, MAX_ID_LENGTH) ?? this.opts.agentId ?? null;
    const out: ToolCallCheck[] = [];
    for (const block of content as unknown[]) {
      if (!isRecord(block) || block.type !== 'tool_use') continue;
      const toolName = typeof block.name === 'string' ? block.name : '';
      const evaluation = this.evaluator.evaluate(toolName, block.input);
      const event = this.toolEvent(toolName, block.input, evaluation, sessionId, agentId);
      this.emit(event);
      this.notify(event, evaluation);
      out.push({
        toolUseId: typeof block.id === 'string' ? block.id : '',
        toolName,
        eventId: event.event_id,
        evaluation,
        allowed: evaluation.disposition === 'pass' || evaluation.disposition === 'warn',
      });
    }
    return out;
  }

  /** Derives a metadata-only request_evaluated event from a finished span. */
  onSpan(span: Span): void {
    const checks = Array.isArray(span.policyChecks) ? span.policyChecks : [];
    if (checks.length === 0) return;
    const hits = checks.filter((c) => c.result !== 'pass');
    const strictest: PolicyCheck | undefined =
      hits.find((c) => c.result === 'block') ?? hits.find((c) => c.result === 'warn');
    const disposition = strictest ? strictest.result : 'pass';
    const ruleIds = [...new Set(hits.map((c) => c.ruleName))];
    const model = clip(span.model, MAX_NAME_LENGTH);
    const event: AuditEvent = {
      ...this.base(
        'request_evaluated',
        clip(span.traceId, MAX_ID_LENGTH),
        clip(span.agentId, MAX_ID_LENGTH) ?? this.opts.agentId ?? null,
      ),
      rule_id: strictest?.ruleName ?? null,
      matched_rule_ids: ruleIds,
      action_type: 'model_request',
      action_summary: `model request to ${model ?? 'unknown model'}`,
      disposition,
      reason_code: strictest ? `${strictest.ruleType}_${strictest.result}` : 'no_rule_matched',
      latency_ms: null,
      model,
    };
    this.emit(event);
    if (strictest && this.opts.webhook) this.opts.webhook.enqueue(this.payload(event, null));
  }

  // -------------------------------------------------------------------------

  private async review(
    event: AuditEvent,
    evaluation: ToolEvaluation,
    toolName: string,
    input: unknown,
    sessionId: string | null,
    agentId: string | null,
  ): Promise<boolean> {
    const started = Date.now();
    let outcome: NonNullable<AuditEvent['review_outcome']>;
    const reviewer = this.opts.onHumanReview;
    if (!reviewer) {
      outcome = 'no_reviewer';
    } else {
      try {
        const decision = await withTimeout(
          Promise.resolve(
            reviewer({
              eventId: event.event_id,
              ruleId: evaluation.ruleId ?? '',
              toolName,
              toolMethod: evaluation.toolMethod,
              paramNames: event.param_names,
              input,
              sessionId,
              agentId,
            }),
          ),
          this.opts.humanReviewTimeoutMs,
        );
        outcome = decision === TIMEOUT ? 'timeout' : decision === 'approve' ? 'approved' : 'denied';
      } catch {
        outcome = 'error';
      }
    }
    this.emit({
      ...this.base('review_resolved', sessionId, agentId),
      related_event_id: event.event_id,
      rule_id: evaluation.ruleId,
      matched_rule_ids: evaluation.matchedRuleIds,
      action_type: 'tool_call',
      tool_name: event.tool_name,
      tool_method: event.tool_method,
      review_outcome: outcome,
      latency_ms: Date.now() - started,
    });
    return outcome === 'approved';
  }

  private toolEvent(
    toolName: string,
    input: unknown,
    evaluation: ToolEvaluation,
    sessionId: string | null,
    agentId: string | null,
  ): AuditEvent {
    const name = clip(toolName, MAX_NAME_LENGTH) ?? '';
    const paramNames = isRecord(input)
      ? Object.keys(input)
          .sort()
          .slice(0, MAX_PARAM_NAMES)
          .map((k) => k.slice(0, MAX_NAME_LENGTH))
      : [];
    const method = evaluation.toolMethod;
    return {
      ...this.base('tool_call_evaluated', sessionId, agentId),
      rule_id: evaluation.ruleId,
      matched_rule_ids: evaluation.matchedRuleIds,
      action_type: 'tool_call',
      tool_name: name,
      tool_method: method,
      param_names: paramNames,
      action_payload_hash: this.opts.payloadHashKey
        ? hmacSha256Hex(this.opts.payloadHashKey, canonicalJson(input ?? null))
        : null,
      action_summary: `${name}${method ? `.${method}` : ''} called with [${paramNames.join(', ')}]`,
      disposition: evaluation.disposition,
      reason_code: evaluation.reasonCode,
      latency_ms: evaluation.latencyMs,
    };
  }

  private notify(event: AuditEvent, evaluation: ToolEvaluation): void {
    if (evaluation.disposition === 'pass' || !this.opts.webhook) return;
    this.opts.webhook.enqueue(this.payload(event, evaluation.escalateTo));
  }

  private payload(event: AuditEvent, escalateTo: string | null): ViolationPayload {
    return {
      event: 'policy_violation',
      quotagate_version: SDK_VERSION,
      timestamp: event.occurred_at,
      event_id: event.event_id,
      session_id: event.session_id,
      agent_id: event.agent_id,
      rule_id: event.rule_id,
      matched_rule_ids: event.matched_rule_ids,
      rule_version: event.rule_version,
      policy_hash: event.policy_hash,
      action_type: event.action_type ?? 'tool_call',
      action_summary: event.action_summary ?? '',
      disposition: event.disposition ?? 'warn',
      escalate_to: escalateTo,
      latency_ms: event.latency_ms,
    };
  }

  private base(
    type: AuditEvent['event_type'],
    sessionId: string | null,
    agentId: string | null,
  ): AuditEvent {
    const now = Date.now();
    return {
      event_id: uuidv7(now),
      event_type: type,
      occurred_at: new Date(now).toISOString(),
      sdk_version: SDK_VERSION,
      session_id: sessionId,
      agent_id: agentId,
      policy_hash: this.policy.policyHash,
      policy_version: this.policy.policyVersion,
      rule_version: this.policy.policyVersion,
      rule_id: null,
      matched_rule_ids: [],
      action_type: null,
      tool_name: null,
      tool_method: null,
      param_names: [],
      action_payload_hash: null,
      action_summary: null,
      disposition: null,
      reason_code: null,
      latency_ms: null,
    };
  }

  private emit(event: AuditEvent): void {
    emitTo(this.opts.onAuditEvent, event, this.opts.logger);
  }
}

/** Delivers an event to the customer's sink; sink failures are logged without details. */
export function emitTo(
  sink: ((event: AuditEvent) => void | Promise<void>) | undefined,
  event: AuditEvent,
  logger: Logger,
): void {
  if (!sink) return;
  const warn = () => {
    try {
      logger(`onAuditEvent sink failed for ${event.event_type} event ${event.event_id}`);
    } catch {
      // never throw from logging
    }
  };
  try {
    const r = sink(event);
    if (isThenable(r)) r.then(undefined, warn);
  } catch {
    warn();
  }
}

/** Audit event for a policy file that failed to load (no Governance instance exists yet). */
export function policyLoadFailedEvent(
  fileName: string,
  errorCode: string,
  agentId?: string,
): AuditEvent {
  const now = Date.now();
  return {
    event_id: uuidv7(now),
    event_type: 'policy_load_failed',
    occurred_at: new Date(now).toISOString(),
    sdk_version: SDK_VERSION,
    session_id: null,
    agent_id: clip(agentId, MAX_ID_LENGTH),
    policy_hash: null,
    policy_version: null,
    rule_version: null,
    rule_id: null,
    matched_rule_ids: [],
    action_type: null,
    tool_name: null,
    tool_method: null,
    param_names: [],
    action_payload_hash: null,
    action_summary: null,
    disposition: null,
    reason_code: errorCode,
    latency_ms: null,
    policy_file_name: clip(fileName, MAX_NAME_LENGTH),
    error_code: errorCode,
  };
}

const TIMEOUT = Symbol('timeout');

function withTimeout<T>(p: Promise<T>, ms: number | undefined): Promise<T | typeof TIMEOUT> {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return p;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(TIMEOUT), ms);
    (t as { unref?: () => void }).unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error('review failed'));
      },
    );
  });
}

function clip(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.length > 0 ? v.slice(0, max) : null;
}
