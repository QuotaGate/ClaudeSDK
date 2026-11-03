import type { QuotaGateOptions, Span } from './types.js';
import { RingBuffer, DEFAULT_BUFFER_SIZE } from './buffer.js';
import { FlushWorker } from './flush-worker.js';
import { PolicyEngine } from './policy/engine.js';
import { Tracer } from './span.js';
import { wrapAnthropic, type AnthropicLike } from './client.js';
import { stderrLogger, type Logger } from './internal/util.js';
import { SDK_VERSION } from './version.js';

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

  constructor(options: QuotaGateOptions = {}, internal: { logger?: Logger } = {}) {
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
      captureContent: options.captureContent !== false,
      onPolicyError: options.onPolicyError ?? 'log',
      logger: this.logger,
    });
  }

  /**
   * Wraps an Anthropic client. The returned object has the same type and behaviour as
   * the client passed in; remove the wrap() call and application code is unchanged.
   */
  wrap<T extends AnthropicLike>(anthropic: T): T {
    return wrapAnthropic(anthropic, this.tracer);
  }

  /** Sends all buffered spans now. Resolves when delivery settles; never rejects. */
  flush(): Promise<void> {
    return this.worker ? this.worker.flush() : Promise.resolve();
  }

  /** Stops the flush timer and flushes remaining spans. Never rejects. */
  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.worker?.stop();
    if (this.beforeExitHandler) process.removeListener('beforeExit', this.beforeExitHandler);
    await this.flush();
  }

  private record(span: Span): void {
    if (!this.worker) return;
    this.buffer.push(span);
    this.worker.notify();
  }
}
