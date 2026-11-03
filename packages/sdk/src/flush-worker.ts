import type { RingBuffer } from './buffer.js';
import { defer, errorMessage, sleepUnref, stderrLogger, type Logger } from './internal/util.js';

export const DEFAULT_FLUSH_INTERVAL_MS = 2000;
export const DEFAULT_FLUSH_BATCH_SIZE = 100;
/** Backend ingest limit (TECHNICAL_SPECS 3.1). Larger drains are split into several requests. */
export const MAX_SPANS_PER_REQUEST = 200;
/** One initial attempt, then three retries after 1s, 2s and 4s. */
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [1000, 2000, 4000];
const REQUEST_TIMEOUT_MS = 10_000;

export interface FlushWorkerOptions {
  /** Full ingest URL, e.g. https://<ingest-host>/v1/ingest (production domain TBD) */
  url: string;
  apiKey: string;
  projectId: string;
  sdkVersion: string;
  intervalMs?: number;
  batchSize?: number;
  retryDelaysMs?: readonly number[];
  fetch?: typeof fetch;
  /** gzip request bodies when CompressionStream is available. Default true. */
  compress?: boolean;
  logger?: Logger;
  /** Suppress failure logging. */
  silent?: boolean;
}

class NonRetryableError extends Error {}

/**
 * Background flusher: drains the ring buffer on a timer and when the buffer reaches
 * `batchSize`, POSTs batches as JSON, retries with exponential backoff, and never throws.
 * All work happens off the caller's critical path.
 */
export class FlushWorker<T = unknown> {
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly retryDelaysMs: readonly number[];
  private readonly logger: Logger;
  private timer: ReturnType<typeof setInterval> | undefined;
  private thresholdFlushScheduled = false;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly buffer: RingBuffer<T>,
    private readonly opts: FlushWorkerOptions,
  ) {
    this.intervalMs = positiveOr(opts.intervalMs, DEFAULT_FLUSH_INTERVAL_MS);
    this.batchSize = positiveOr(opts.batchSize, DEFAULT_FLUSH_BATCH_SIZE);
    this.retryDelaysMs = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.logger = opts.logger ?? stderrLogger;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), this.intervalMs);
    // Never keep the host process alive just for the flush timer.
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  get running(): boolean {
    return this.timer !== undefined;
  }

  /** Call after every buffer push. Schedules an async flush once the threshold is reached. */
  notify(): void {
    if (this.buffer.size < this.batchSize || this.thresholdFlushScheduled) return;
    this.thresholdFlushScheduled = true;
    defer(() => {
      this.thresholdFlushScheduled = false;
      void this.flush();
    });
  }

  /**
   * Drains the buffer and sends everything. Resolves when this drain and every
   * in-flight send have settled. Never rejects.
   */
  flush(): Promise<void> {
    const items = this.buffer.drain();
    for (let i = 0; i < items.length; i += MAX_SPANS_PER_REQUEST) {
      const batch = items.slice(i, i + MAX_SPANS_PER_REQUEST);
      const p = this.sendWithRetry(batch).finally(() => this.inFlight.delete(p));
      this.inFlight.add(p);
    }
    return Promise.all([...this.inFlight]).then(
      () => undefined,
      () => undefined,
    );
  }

  private async sendWithRetry(batch: T[]): Promise<void> {
    const attempts = this.retryDelaysMs.length + 1;
    let lastError = 'unknown error';
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await sleepUnref(this.retryDelaysMs[attempt - 1] ?? 0);
      try {
        await this.send(batch);
        return;
      } catch (err) {
        lastError = errorMessage(err);
        if (err instanceof NonRetryableError) break;
      }
    }
    this.log(
      `failed to deliver ${batch.length} span(s) to ${this.opts.url}: ${lastError}; batch discarded`,
    );
  }

  private async send(batch: T[]): Promise<void> {
    const fetchImpl = this.opts.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') throw new NonRetryableError('fetch is not available');

    const json = JSON.stringify({
      sdkVersion: this.opts.sdkVersion,
      projectId: this.opts.projectId,
      spans: batch,
    });
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      authorization: `Bearer ${this.opts.apiKey}`,
      'user-agent': `quotagate-sdk-js/${this.opts.sdkVersion}`,
    };
    let body: string | Uint8Array = json;
    if (this.opts.compress !== false) {
      const gz = await gzip(json);
      if (gz) {
        body = gz;
        headers['content-encoding'] = 'gzip';
      }
    }

    const res = await fetchImpl(this.opts.url, {
      method: 'POST',
      headers,
      body: body as NonNullable<RequestInit['body']>,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      const msg = `HTTP ${res.status}`;
      // 4xx other than timeout/rate-limit will not succeed on retry (bad key, bad payload).
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
        throw new NonRetryableError(msg);
      }
      throw new Error(msg);
    }
    this.logRejected(text);
  }

  private logRejected(text: string): void {
    if (!text) return;
    try {
      const parsed = JSON.parse(text) as { rejected?: unknown; errors?: unknown };
      if (typeof parsed.rejected === 'number' && parsed.rejected > 0) {
        this.log(
          `ingest rejected ${parsed.rejected} span(s): ${JSON.stringify(parsed.errors ?? []).slice(0, 500)}`,
        );
      }
    } catch {
      // Non-JSON success bodies are fine.
    }
  }

  private log(msg: string): void {
    if (this.opts.silent) return;
    try {
      this.logger(msg);
    } catch {
      // Logging must never throw into the flush path.
    }
  }
}

function positiveOr(v: number | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
}

async function gzip(text: string): Promise<Uint8Array | undefined> {
  if (typeof CompressionStream === 'undefined') return undefined;
  try {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return undefined;
  }
}
