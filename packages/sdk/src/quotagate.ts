import type { Policy, QuotaGateOptions, Span } from './types.js';
import { RingBuffer, DEFAULT_BUFFER_SIZE } from './buffer.js';
import { FlushWorker } from './flush-worker.js';
import { PolicyEngine } from './policy/engine.js';
import { Tracer } from './span.js';
import { wrapAnthropic, type AnthropicLike } from './client.js';
import { stderrLogger, type Logger } from './internal/util.js';
import { SDK_VERSION } from './version.js';
import { PolicyFileError } from './governance/errors.js';
import { loadPolicyFile, parsePolicySource } from './governance/schema.js';
import { Governance, emitTo, policyLoadFailedEvent } from './governance/runtime.js';
import { WebhookDispatcher, validateWebhookOptions } from './governance/webhook.js';
import type {
  LoadedPolicy,
  QuotaGateInitOptions,
  ToolCallCheck,
  ToolEvaluation,
  ToolGuardContext,
} from './governance/types.js';

// TODO(TBD): production ingest domain not yet provisioned. `.invalid` (RFC 2606) is a deliberate
// placeholder that never resolves; pass `endpoint` explicitly until the hosted backend exists.
export const DEFAULT_ENDPOINT = 'https://ingest.quotagate.invalid';

/**
 * QuotaGate entry point.
 *
 * ```ts
 * const quotagate = new QuotaGate({ apiKey, projectId, policies });
 * const claude = quotagate.wrap(new Anthropic()); // same type as Anthropic
 * ```
 *
 * Spans are captured asynchronously and flushed in the background; a failed flush is
 * logged to stderr and never surfaces in application code.
 */
export class QuotaGate {
  readonly sdkVersion = SDK_VERSION;
  /** Whether spans are exported (apiKey and projectId are both set). */
  readonly exporting: boolean;

  private readonly buffer: RingBuffer<Span>;
  private readonly worker: FlushWorker<Span> | undefined;
  private readonly tracer: Tracer;
  private readonly logger: Logger;
  private readonly beforeExitHandler: (() => void) | undefined;
  private closed = false;
  private governance: Governance | undefined;

  /**
   * Track B entry point (metadata-only mode). Loads, validates and hashes the policy file,
   * emits `policy_activated`, and returns a QuotaGate with tool-call governance enabled.
   *
   * Throws PolicyFileError when the file is missing or invalid (after emitting
   * `policy_load_failed` to `onAuditEvent`), so an agent never starts without a policy.
   * Throws TypeError for invalid options (e.g. captureContent: true, non-https webhook).
   *
   * Audit events go only to `onAuditEvent`: no QuotaGate backend endpoint exists yet.
   */
  static async init(
    options: QuotaGateInitOptions,
    internal: { logger?: Logger } = {},
  ): Promise<QuotaGate> {
    const logger = internal.logger ?? stderrLogger;
    const o = (options ?? {}) as QuotaGateInitOptions & {
      policies?: unknown;
      captureContent?: unknown;
    };
    if (o.captureContent !== undefined && o.captureContent !== false) {
      throw new TypeError('QuotaGate.init: captureContent must be false in metadata-only mode');
    }
    if (o.policies !== undefined) {
      throw new TypeError(
        'QuotaGate.init: inline `policies` are not supported; declare request_rules in the policy file so they are hashed and versioned',
      );
    }
    if (!o.policyFile === !o.policySource) {
      throw new TypeError('QuotaGate.init: exactly one of policyFile or policySource is required');
    }
    if (o.webhook !== undefined) validateWebhookOptions(o.webhook);

    let policy: LoadedPolicy;
    try {
      const src = o.policySource;
      if (
        src &&
        (typeof src.fileName !== 'string' || src.text === undefined || src.text === null)
      ) {
        throw new PolicyFileError({
          code: 'invalid_policy_source',
          fileName: 'policy',
          detail: 'policySource needs text and fileName',
        });
      }
      policy = src
        ? parsePolicySource(src.text, src.fileName, { policyVersion: o.policyVersion })
        : await loadPolicyFile(String(o.policyFile), { policyVersion: o.policyVersion });
    } catch (err) {
      const fileName = err instanceof PolicyFileError ? err.fileName : 'policy';
      const code = err instanceof PolicyFileError ? err.code : 'load_failed';
      emitTo(o.onAuditEvent, policyLoadFailedEvent(fileName, code, o.agentId), logger);
      throw err;
    }

    const requestRules = policy.document.request_rules ?? [];
    const policies: Policy[] = requestRules.length
      ? [{ policyId: 'policy_file', name: 'request_rules', scope: 'project', rules: requestRules }]
      : [];
    const qg = new QuotaGate(
      { ...o, policies, captureContent: false },
      { logger, metadataOnly: true },
    );
    let governance: Governance | undefined = undefined;
    const webhook = o.webhook
      ? new WebhookDispatcher({
          ...o.webhook,
          fetch: o.fetch,
          logger,
          silent: o.onFlushError === 'silent',
          onResult: (r) => governance?.onDeliveryResult(r),
        })
      : undefined;
    governance = new Governance({
      policy,
      agentId: o.agentId,
      payloadHashKey: o.payloadHashKey,
      onAuditEvent: o.onAuditEvent,
      onHumanReview: o.onHumanReview,
      humanReviewTimeoutMs: o.humanReviewTimeoutMs,
      webhook,
      logger,
    });
    qg.governance = governance;
    governance.policyActivated(o.policyChangeContext);
    return qg;
  }

  constructor(
    options: QuotaGateOptions = {},
    internal: { logger?: Logger; metadataOnly?: boolean } = {},
  ) {
    this.logger = internal.logger ?? stderrLogger;
    const silent = options.onFlushError === 'silent';
    const bufferSize =
      Number.isInteger(options.bufferSize) && (options.bufferSize ?? 0) > 0
        ? (options.bufferSize as number)
        : DEFAULT_BUFFER_SIZE;
    this.buffer = new RingBuffer<Span>(bufferSize, this.logger);

    const apiKey = options.apiKey?.trim();
    const projectId = options.projectId?.trim();
    this.exporting = Boolean(apiKey && projectId);

    if (apiKey && projectId) {
      const endpoint = (options.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, '');
      this.worker = new FlushWorker<Span>(this.buffer, {
        url: `${endpoint}/v1/ingest`,
        apiKey,
        projectId,
        sdkVersion: SDK_VERSION,
        intervalMs: options.flushInterval,
        batchSize: options.flushBatchSize,
        fetch: options.fetch,
        logger: this.logger,
        silent,
        redactServerDetail: internal.metadataOnly === true,
      });
      this.worker.start();
      if (typeof process !== 'undefined' && typeof process.once === 'function') {
        // Flush what is buffered when the event loop drains on a clean exit.
        this.beforeExitHandler = () => void this.flush();
        process.once('beforeExit', this.beforeExitHandler);
      }
    } else if (!silent) {
      this.logger(
        'apiKey and/or projectId not set: spans will not be exported. Policies still run locally.',
      );
    }

    this.tracer = new Tracer({
      policyEngine: new PolicyEngine(options.policies ?? [], {
        onPolicyError: options.onPolicyError,
        logger: this.logger,
      }),
      record: (span) => this.record(span),
      // Default false since decision A3 (was true, DECISIONS D9): opt in with captureContent: true.
      captureContent: internal.metadataOnly ? false : options.captureContent === true,
      onPolicyError: options.onPolicyError ?? 'log',
      logger: this.logger,
      metadataOnly: internal.metadataOnly === true,
    });
  }

  /**
   * Wraps an Anthropic client. The returned object has the same type and behaviour as
   * the client passed in; remove the wrap() call and application code is unchanged.
   */
  wrap<T extends AnthropicLike>(anthropic: T): T {
    return wrapAnthropic(anthropic, this.tracer);
  }

  /** Policy identifiers when created with QuotaGate.init(); undefined otherwise. */
  get policy():
    | { fileName: string; policyHash: string; canonicalHash: string; policyVersion: string }
    | undefined {
    const p = this.governance?.policy;
    return p
      ? {
          fileName: p.fileName,
          policyHash: p.policyHash,
          canonicalHash: p.canonicalHash,
          policyVersion: p.policyVersion,
        }
      : undefined;
  }

  /**
   * Wraps a tool function so every call is evaluated against the policy file before it runs.
   * `block` / `error_blocked` throw ToolCallDeniedError without running the tool;
   * `require_human_review` runs only if `onHumanReview` approves. Tools that bypass
   * guardTool are not enforced. Requires QuotaGate.init().
   */
  guardTool<I, R>(
    toolName: string,
    executor: (input: I, context?: ToolGuardContext) => R | Promise<R>,
  ): (input: I, context?: ToolGuardContext) => Promise<Awaited<R>> {
    return this.requireGovernance('guardTool').guardTool(toolName, executor);
  }

  /** Evaluates the tool_use blocks of a Claude response (advisory). Requires QuotaGate.init(). */
  checkToolCalls(message: unknown, context?: ToolGuardContext): ToolCallCheck[] {
    return this.requireGovernance('checkToolCalls').checkToolCalls(message, context);
  }

  /** Evaluates one tool call without running it or emitting events. Requires QuotaGate.init(). */
  evaluateToolCall(toolName: string, input: unknown): ToolEvaluation {
    return this.requireGovernance('evaluateToolCall').evaluate(toolName, input);
  }

  /** Sends all buffered spans and queued webhooks now. Resolves when delivery settles; never rejects. */
  async flush(): Promise<void> {
    await Promise.all([
      this.worker ? this.worker.flush() : Promise.resolve(),
      this.governance?.webhook?.flush() ?? Promise.resolve(),
    ]);
  }

  /** Stops the flush timer and flushes remaining spans. Never rejects. */
  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.worker?.stop();
    if (this.beforeExitHandler) process.removeListener('beforeExit', this.beforeExitHandler);
    await this.flush();
    await this.governance?.webhook?.shutdown();
  }

  private requireGovernance(method: string): Governance {
    if (!this.governance) {
      throw new TypeError(
        `QuotaGate.${method}() requires an instance created with QuotaGate.init()`,
      );
    }
    return this.governance;
  }

  private record(span: Span): void {
    try {
      this.governance?.onSpan(span);
    } catch {
      // Audit derivation must never affect span export.
    }
    if (!this.worker) return;
    this.buffer.push(span);
    this.worker.notify();
  }
}
