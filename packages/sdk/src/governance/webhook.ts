import { sleepUnref, type Logger } from '../internal/util.js';
import { hmacSha256Hex } from './hash.js';
import type { WebhookOptions } from './types.js';

export const DEFAULT_WEBHOOK_TIMEOUT_MS = 5000;
/** Three attempts in total: immediately, then after 2 s and 8 s (plus jitter). */
export const DEFAULT_WEBHOOK_RETRY_DELAYS_MS: readonly number[] = [2000, 8000];
export const DEFAULT_WEBHOOK_MAX_QUEUE = 100;
const MAX_JITTER_MS = 500;

/** PRD Track B Feature 3 payload, plus event_id, policy_hash and delivery_attempt. */
export interface ViolationPayload {
  event: 'policy_violation';
  quotagate_version: string;
  timestamp: string;
  event_id: string;
  session_id: string | null;
  agent_id: string | null;
  rule_id: string | null;
  matched_rule_ids: string[];
  rule_version: string | null;
  policy_hash: string | null;
  action_type: 'tool_call' | 'model_request';
  /** Tool name, method and parameter names only. Never parameter values. */
  action_summary: string;
  disposition: string;
  escalate_to: string | null;
  latency_ms: number | null;
  delivery_attempt?: number;
}

export interface DeliveryResult {
  eventId: string;
  status: 'delivered' | 'failed' | 'dropped';
  attempts: number;
  httpStatus: number | null;
}

export interface WebhookDispatcherOptions extends WebhookOptions {
  fetch?: typeof fetch;
  logger: Logger;
  silent?: boolean;
  /** Called once per payload with the final outcome (metadata only). */
  onResult: (result: DeliveryResult) => void;
  /** Override for tests. */
  random?: () => number;
  now?: () => number;
}

/** Validates webhook options. Throws TypeError with a message that never contains the secret. */
export function validateWebhookOptions(o: WebhookOptions): void {
  if (!o || typeof o.url !== 'string') throw new TypeError('webhook.url is required');
  let url: URL;
  try {
    url = new URL(o.url);
  } catch {
    throw new TypeError('webhook.url is not a valid URL');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && o.allowInsecureHttp === true)) {
    throw new TypeError(
      'webhook.url must use https:// (set allowInsecureHttp only for local testing)',
    );
  }
  if (url.username || url.password) throw new TypeError('webhook.url must not embed credentials');
  if (typeof o.secret !== 'string' || o.secret.length < 16) {
    throw new TypeError(
      'webhook.secret is required (at least 16 characters; 32+ random bytes recommended)',
    );
  }
}

/** Signature header value: v1=<hex HMAC-SHA256(secret, `${timestamp}.${rawBody}`)>. */
export function signWebhook(secret: string, timestamp: number, rawBody: string): string {
  return `v1=${hmacSha256Hex(secret, `${timestamp}.${rawBody}`)}`;
}

/**
 * Bounded, in-process, asynchronous webhook dispatcher.
 *
 * - `enqueue()` never blocks or throws; delivery runs in the background.
 * - At most `maxQueue` payloads wait; beyond that new payloads are dropped and reported.
 * - Pending payloads are lost if the process exits before delivery. There is no durable
 *   outbox; this is a notification channel, not a control (PRD F3).
 * - Logs contain only event ids, attempt counts and HTTP status codes: never bodies,
 *   response text, the URL query or the secret.
 */
export class WebhookDispatcher {
  private readonly queue: ViolationPayload[] = [];
  private readonly timeoutMs: number;
  private readonly retryDelaysMs: readonly number[];
  private readonly maxQueue: number;
  private readonly target: string;
  private running: Promise<void> | null = null;
  private stopped = false;

  constructor(private readonly opts: WebhookDispatcherOptions) {
    validateWebhookOptions(opts);
    this.timeoutMs = positive(opts.timeoutMs, DEFAULT_WEBHOOK_TIMEOUT_MS);
    this.retryDelaysMs = opts.retryDelaysMs ?? DEFAULT_WEBHOOK_RETRY_DELAYS_MS;
    this.maxQueue = positive(opts.maxQueue, DEFAULT_WEBHOOK_MAX_QUEUE);
    const u = new URL(opts.url);
    this.target = `${u.protocol}//${u.host}`;
  }

  get pending(): number {
    return this.queue.length;
  }

  enqueue(payload: ViolationPayload): void {
    if (this.stopped || this.queue.length >= this.maxQueue) {
      this.log(`webhook queue full or stopped; dropped event ${payload.event_id}`);
      this.report({ eventId: payload.event_id, status: 'dropped', attempts: 0, httpStatus: null });
      return;
    }
    this.queue.push(payload);
    if (!this.running) {
      this.running = this.drain().finally(() => {
        this.running = null;
      });
    }
  }

  /** Resolves when the queue is empty and in-flight deliveries settle. Never rejects. */
  async flush(): Promise<void> {
    while (this.running) await this.running.catch(() => undefined);
  }

  /** Stops accepting payloads and waits for queued ones. */
  async shutdown(): Promise<void> {
    this.stopped = true;
    await this.flush();
  }

  private async drain(): Promise<void> {
    let next: ViolationPayload | undefined;
    while ((next = this.queue.shift())) {
      try {
        this.report(await this.deliver(next));
      } catch {
        this.report({ eventId: next.event_id, status: 'failed', attempts: 0, httpStatus: null });
      }
    }
  }

  private async deliver(payload: ViolationPayload): Promise<DeliveryResult> {
    const attempts = this.retryDelaysMs.length + 1;
    let httpStatus: number | null = null;
    let lastProblem = 'unknown';
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (attempt > 1) {
        const jitter = Math.floor((this.opts.random ?? Math.random)() * MAX_JITTER_MS);
        await sleepUnref((this.retryDelaysMs[attempt - 2] ?? 0) + jitter);
      }
      const outcome = await this.attempt(payload, attempt);
      httpStatus = outcome.status;
      if (outcome.ok)
        return { eventId: payload.event_id, status: 'delivered', attempts: attempt, httpStatus };
      lastProblem = outcome.status === null ? 'network error or timeout' : `HTTP ${outcome.status}`;
      if (!outcome.retryable) {
        this.log(
          `webhook ${payload.event_id} to ${this.target} failed (${lastProblem}); not retried`,
        );
        return { eventId: payload.event_id, status: 'failed', attempts: attempt, httpStatus };
      }
    }
    this.log(
      `webhook ${payload.event_id} to ${this.target} failed after ${attempts} attempts (${lastProblem})`,
    );
    return { eventId: payload.event_id, status: 'failed', attempts, httpStatus };
  }

  private async attempt(
    payload: ViolationPayload,
    attempt: number,
  ): Promise<{ ok: boolean; status: number | null; retryable: boolean }> {
    const fetchImpl = this.opts.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') return { ok: false, status: null, retryable: false };
    const body = JSON.stringify({ ...payload, delivery_attempt: attempt });
    const ts = Math.floor((this.opts.now ?? Date.now)() / 1000);
    try {
      const res = await fetchImpl(this.opts.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': `quotagate-sdk-js/${payload.quotagate_version}`,
          'QuotaGate-Event-Id': payload.event_id,
          'QuotaGate-Timestamp': String(ts),
          'QuotaGate-Signature': signWebhook(this.opts.secret, ts, body),
        },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      // Drain without reading the text into logs.
      await res.arrayBuffer().catch(() => undefined);
      if (res.status >= 200 && res.status < 300)
        return { ok: true, status: res.status, retryable: false };
      const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
      return { ok: false, status: res.status, retryable };
    } catch {
      return { ok: false, status: null, retryable: true };
    }
  }

  private report(result: DeliveryResult): void {
    try {
      this.opts.onResult(result);
    } catch {
      // A failing sink must not stop delivery.
    }
  }

  private log(msg: string): void {
    if (this.opts.silent) return;
    try {
      this.opts.logger(msg);
    } catch {
      // never throw from logging
    }
  }
}

function positive(v: number | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
}
