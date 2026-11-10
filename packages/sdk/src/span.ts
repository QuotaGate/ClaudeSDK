import type Anthropic from '@anthropic-ai/sdk';
import type { QuotaGateContext, PolicyCheck, Span, ToolCallRecord } from './types.js';
import type { PolicyEngine } from './policy/engine.js';
import { PolicyViolationError } from './policy/errors.js';
import { systemText } from './policy/text.js';
import { defer, errorMessage, isRecord, uuid, type Logger } from './internal/util.js';
import { SDK_VERSION } from './version.js';

type Params = Record<string, unknown>;

export interface TracerOptions {
  policyEngine?: PolicyEngine;
  /** Receives finished spans (called asynchronously, off the caller's critical path). */
  record: (span: Span) => void;
  captureContent: boolean;
  onPolicyError: 'log' | 'block';
  logger: Logger;
  /**
   * Metadata-only mode (set by QuotaGate.init): span metadata is dropped and error
   * messages are reduced to an error class label, so no free-form text leaves the process.
   */
  metadataOnly?: boolean;
}

/** Span fields known before the Anthropic call. */
interface SpanStart {
  spanId: string;
  traceId: string;
  parentSpanId: string | null;
  agentId: string | null;
  taskLabel: string | null;
  metadata: Record<string, unknown>;
  model: string;
  system: string | null;
  messages: Anthropic.MessageParam[];
  startedAt: number;
  streamed: boolean;
}

/**
 * Creates spans around Anthropic calls: pre-flight policy evaluation, then
 * completion from a response, a stream of events, or an error.
 */
export class Tracer {
  constructor(private readonly opts: TracerOptions) {}

  /**
   * Starts a span and runs pre-flight policies. Throws PolicyViolationError when the
   * call must be blocked (the blocked attempt is recorded as an error span). Never
   * throws anything else: internal failures return undefined and the call proceeds
   * uninstrumented.
   */
  start(
    params: unknown,
    ctx: QuotaGateContext | undefined,
    streamed: boolean,
  ): SpanHandle | undefined {
    let start: SpanStart;
    try {
      const p: Params = isRecord(params) ? params : {};
      start = {
        spanId: uuid(),
        traceId: nonEmpty(ctx?.traceId) ?? uuid(),
        parentSpanId: nonEmpty(ctx?.parentSpanId) ?? null,
        agentId: nonEmpty(ctx?.agentId) ?? null,
        taskLabel: nonEmpty(ctx?.taskLabel) ?? null,
        metadata: isRecord(ctx?.metadata) ? { ...ctx.metadata } : {},
        model: typeof p.model === 'string' ? p.model : 'unknown',
        system: systemText(p.system),
        // Shallow copy: apps commonly push the reply onto the same array after the call.
        messages: Array.isArray(p.messages) ? [...(p.messages as Anthropic.MessageParam[])] : [],
        startedAt: Date.now(),
        streamed,
      };
    } catch (err) {
      this.log(`span setup failed: ${errorMessage(err)}`);
      return undefined;
    }

    let checks: PolicyCheck[] = [];
    const engine = this.opts.policyEngine;
    if (engine && engine.size > 0) {
      try {
        checks = engine.evaluate(params as Params, {
          traceId: start.traceId,
          agentId: start.agentId ?? undefined,
          taskLabel: start.taskLabel ?? undefined,
        });
      } catch (err) {
        if (err instanceof PolicyViolationError) {
          this.recordBlocked(start, err);
          throw err;
        }
        const reason = `policy engine failed: ${errorMessage(err)}`;
        if (this.opts.onPolicyError === 'block') {
          const pv = new PolicyViolationError({
            policyId: 'quotagate',
            ruleName: 'policy_engine_error',
            ruleType: 'policy_engine_error',
            reason,
          });
          this.recordBlocked(start, pv);
          throw pv;
        }
        this.log(`${reason}; allowing call (onPolicyError: 'log')`);
      }
    }
    return new SpanHandle(start, checks, this.opts);
  }

  private recordBlocked(start: SpanStart, err: PolicyViolationError): void {
    const handle = new SpanHandle(start, err.policyChecks, this.opts);
    handle.fail(err);
  }

  private log(msg: string): void {
    safeLog(this.opts.logger, msg);
  }
}

/** One in-flight span. Exactly one of complete()/fail() takes effect. */
export class SpanHandle {
  private finished = false;
  private readonly accumulator: StreamAccumulator;

  constructor(
    private readonly start: SpanStart,
    private readonly checks: PolicyCheck[],
    private readonly opts: TracerOptions,
  ) {
    this.accumulator = new StreamAccumulator(opts.captureContent);
  }

  get spanId(): string {
    return this.start.spanId;
  }

  get traceId(): string {
    return this.start.traceId;
  }

  complete(message: unknown): void {
    if (this.finished) return;
    this.finished = true;
    const completedAt = Date.now();
    // Building and buffering the span happens after the caller has its response.
    defer(() => this.emit(() => this.buildSpan(completedAt, message, null)));
  }

  fail(err: unknown): void {
    if (this.finished) return;
    this.finished = true;
    const completedAt = Date.now();
    const partial = this.accumulator.message;
    const text = this.opts.metadataOnly ? errorLabel(err) : errorMessage(err);
    defer(() => this.emit(() => this.buildSpan(completedAt, partial, text)));
  }

  /** Feed raw stream events (RawMessageStreamEvent). Finalizes on message_stop. */
  onStreamEvent(event: unknown): void {
    if (this.finished) return;
    try {
      this.accumulator.add(event);
      if (isRecord(event) && event.type === 'message_stop') this.complete(this.accumulator.message);
    } catch (err) {
      safeLog(this.opts.logger, `stream capture failed: ${errorMessage(err)}`);
    }
  }

  /** Stream finished or was cancelled; records an error span if message_stop never arrived. */
  endStream(reason = 'stream ended before message_stop'): void {
    if (!this.finished) this.fail(new Error(reason));
  }

  private emit(build: () => Span): void {
    try {
      this.opts.record(build());
    } catch (err) {
      safeLog(this.opts.logger, `failed to record span: ${errorMessage(err)}`);
    }
  }

  private buildSpan(completedAt: number, message: unknown, error: string | null): Span {
    const s = this.start;
    const msg = isRecord(message) ? (message as unknown as Anthropic.Message) : null;
    const usage: Record<string, unknown> = isRecord(msg?.usage) ? (msg.usage as never) : {};
    const capture = this.opts.captureContent;

    let response: Anthropic.Message | null = null;
    if (msg && error === null) {
      response = capture ? msg : ({ ...msg, content: [] } as Anthropic.Message);
    }

    return {
      spanId: s.spanId,
      traceId: s.traceId,
      parentSpanId: s.parentSpanId,
      agentId: s.agentId,
      taskLabel: s.taskLabel,
      metadata: this.opts.metadataOnly ? {} : s.metadata,
      model: (msg && typeof msg.model === 'string' && msg.model) || s.model,
      system: capture ? s.system : null,
      messages: capture ? s.messages : [],
      response,
      inputTokens: int(usage.input_tokens),
      outputTokens: int(usage.output_tokens),
      cacheReadTokens: int(usage.cache_read_input_tokens),
      cacheWriteTokens: int(usage.cache_creation_input_tokens),
      latencyMs: Math.max(0, completedAt - s.startedAt),
      stopReason: error !== null ? 'error' : String(msg?.stop_reason ?? 'end_turn'),
      errorMessage: error,
      toolCalls: msg ? toolCalls(msg, capture) : [],
      policyChecks: this.checks,
      captureContent: capture,
      streamed: s.streamed,
      startedAt: new Date(s.startedAt),
      completedAt: new Date(completedAt),
      sdkVersion: SDK_VERSION,
    };
  }
}

function toolCalls(msg: Anthropic.Message, capture: boolean): ToolCallRecord[] {
  if (!Array.isArray(msg.content)) return [];
  const out: ToolCallRecord[] = [];
  for (const block of msg.content as unknown[]) {
    if (!isRecord(block) || block.type !== 'tool_use') continue;
    out.push({
      toolCallId: String(block.id ?? ''),
      toolName: String(block.name ?? ''),
      toolInput: capture && isRecord(block.input) ? block.input : {},
      toolResult: null,
      childSpanId: null,
    });
  }
  return out;
}

/**
 * Rebuilds the final Message from raw stream events (message_start, content_block_*,
 * message_delta, message_stop). Content is only accumulated when captureContent is on;
 * the events themselves are passed to the application untouched.
 */
export class StreamAccumulator {
  private msg: Record<string, unknown> | null = null;
  private readonly partialJson = new Map<number, string>();

  constructor(private readonly captureContent: boolean) {}

  get message(): Record<string, unknown> | null {
    return this.msg;
  }

  add(event: unknown): void {
    if (!isRecord(event)) return;
    switch (event.type) {
      case 'message_start': {
        const m = isRecord(event.message) ? event.message : {};
        this.msg = {
          ...m,
          content: [],
          usage: isRecord(m.usage) ? { ...m.usage } : {},
        };
        break;
      }
      case 'content_block_start': {
        if (!this.msg || !this.captureContent || typeof event.index !== 'number') break;
        const block = isRecord(event.content_block) ? { ...event.content_block } : {};
        (this.msg.content as unknown[])[event.index] = block;
        break;
      }
      case 'content_block_delta': {
        if (!this.msg || !this.captureContent || typeof event.index !== 'number') break;
        const block = (this.msg.content as Record<string, unknown>[])[event.index];
        const delta = isRecord(event.delta) ? event.delta : {};
        if (!block) break;
        if (delta.type === 'text_delta')
          block.text = String(block.text ?? '') + String(delta.text ?? '');
        else if (delta.type === 'thinking_delta')
          block.thinking = String(block.thinking ?? '') + String(delta.thinking ?? '');
        else if (delta.type === 'signature_delta') block.signature = delta.signature;
        else if (delta.type === 'input_json_delta')
          this.partialJson.set(
            event.index,
            (this.partialJson.get(event.index) ?? '') + String(delta.partial_json ?? ''),
          );
        else if (delta.type === 'citations_delta' && delta.citation !== undefined)
          block.citations = [
            ...(Array.isArray(block.citations) ? block.citations : []),
            delta.citation,
          ];
        break;
      }
      case 'content_block_stop': {
        if (!this.msg || typeof event.index !== 'number') break;
        const json = this.partialJson.get(event.index);
        const block = (this.msg.content as Record<string, unknown>[])[event.index];
        if (block && json !== undefined) {
          try {
            block.input = json ? JSON.parse(json) : {};
          } catch {
            block.input = { _raw: json };
          }
          this.partialJson.delete(event.index);
        }
        break;
      }
      case 'message_delta': {
        if (!this.msg) break;
        const delta = isRecord(event.delta) ? event.delta : {};
        if ('stop_reason' in delta) this.msg.stop_reason = delta.stop_reason;
        if ('stop_sequence' in delta) this.msg.stop_sequence = delta.stop_sequence;
        if (isRecord(event.usage)) {
          const usage = this.msg.usage as Record<string, unknown>;
          for (const [k, v] of Object.entries(event.usage))
            if (v !== null && v !== undefined) usage[k] = v;
        }
        break;
      }
      default:
        break;
    }
  }
}

/** Error class (and HTTP status, if any) without the message text. */
export function errorLabel(err: unknown): string {
  if (err instanceof PolicyViolationError) return `PolicyViolationError: ${err.ruleName}`;
  const name = err instanceof Error && err.name ? err.name : 'Error';
  const status = isRecord(err) && typeof err.status === 'number' ? ` (HTTP ${err.status})` : '';
  return `${name}${status}`;
}

function int(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function nonEmpty(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function safeLog(logger: Logger, msg: string): void {
  try {
    logger(msg);
  } catch {
    // never throw from logging
  }
}
