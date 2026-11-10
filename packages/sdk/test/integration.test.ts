/**
 * Task 1.7: a real QuotaGate instance flushing to an in-file Express mock ingest server.
 * Anthropic is mocked; no network calls leave the machine.
 */
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { QuotaGate } from '../src/index.js';
import { SDK_VERSION } from '../src/version.js';
import { baseParams, createMockAnthropic, mockMessage } from './helpers.js';

interface Received {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: { sdkVersion: string; projectId: string; spans: Record<string, unknown>[] };
  at: number;
}

let server: Server;
let endpoint: string;
let received: Received[] = [];
let waiters: (() => void)[] = [];

beforeAll(async () => {
  const app = express();
  // body-parser inflates `Content-Encoding: gzip` bodies itself (inflate: true).
  app.post('/v1/ingest', express.raw({ type: '*/*', limit: '10mb' }), (req, res) => {
    const body = JSON.parse((req.body as Buffer).toString('utf8')) as Received['body'];
    received.push({ path: req.path, headers: req.headers, body, at: Date.now() });
    res.json({ accepted: body.spans.length, rejected: 0, errors: [] });
    waiters.forEach((w) => w());
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  received = [];
  waiters = [];
});

/** Resolves once the server has received `n` spans in total, or rejects after `ms`. */
function waitForSpans(n: number, ms: number): Promise<void> {
  const count = () => received.reduce((sum, r) => sum + r.body.spans.length, 0);
  return new Promise((resolve, reject) => {
    if (count() >= n) return resolve();
    const timer = setTimeout(
      () => reject(new Error(`timed out after ${ms}ms with ${count()}/${n} spans`)),
      ms,
    );
    waiters.push(() => {
      if (count() >= n) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

describe('QuotaGate SDK integration (Express mock ingest server)', () => {
  it('flushes two spans sharing a traceId within 3 seconds, with fields matching the response', async () => {
    const response = mockMessage({
      id: 'msg_integration',
      model: 'claude-opus-4-5-20251101',
      content: [{ type: 'text', text: 'Contract summary.', citations: null }],
      usage: {
        input_tokens: 321,
        output_tokens: 54,
        cache_creation_input_tokens: 7,
        cache_read_input_tokens: 11,
      } as never,
    });
    const anthropic = createMockAnthropic(response);
    // Default flush settings (2s interval, batch 100): the timer is what must fire in < 3s.
    const quotagate = new QuotaGate({
      apiKey: 'lb_test_key',
      projectId: 'proj_test',
      endpoint,
      captureContent: true,
    }); // A3: content capture is opt-in
    const claude = quotagate.wrap(anthropic);
    const traceId = 'trace-integration-001';

    const start = Date.now();
    const first = await claude.messages.create(baseParams, {
      quotagate: { traceId, agentId: 'contract-agent', taskLabel: 'summarize' },
    });
    const second = await claude.messages.create(
      { ...baseParams, messages: [...baseParams.messages, { role: 'assistant', content: 'ok' }] },
      { quotagate: { traceId, agentId: 'contract-agent', taskLabel: 'summarize' } },
    );
    // Drop-in: the application sees the unmodified Anthropic response.
    expect(first).toBe(response);
    expect(second).toBe(response);

    await waitForSpans(2, 3000);
    const flushMs = received[0]!.at - start;
    expect(flushMs).toBeLessThan(3000);

    const spans = received.flatMap((r) => r.body.spans);
    expect(spans).toHaveLength(2);
    for (const span of spans) {
      expect(span).toMatchObject({
        traceId,
        agentId: 'contract-agent',
        taskLabel: 'summarize',
        model: 'claude-opus-4-5-20251101',
        inputTokens: 321,
        outputTokens: 54,
        cacheWriteTokens: 7,
        cacheReadTokens: 11,
        stopReason: 'end_turn',
        errorMessage: null,
        streamed: false,
        sdkVersion: SDK_VERSION,
      });
      expect(span.response).toMatchObject({ id: 'msg_integration', content: response.content });
      expect(typeof span.latencyMs).toBe('number');
    }
    expect(new Set(spans.map((s) => s.spanId)).size).toBe(2);

    const req = received[0]!;
    expect(req.path).toBe('/v1/ingest');
    expect(req.headers.authorization).toBe('Bearer lb_test_key');
    expect(req.headers['content-encoding']).toBe('gzip');
    expect(req.body).toMatchObject({ projectId: 'proj_test', sdkVersion: SDK_VERSION });

    await quotagate.shutdown();
  });

  it('shutdown() flushes buffered spans immediately', async () => {
    const quotagate = new QuotaGate({
      apiKey: 'lb_test_key',
      projectId: 'proj_test',
      endpoint,
      flushInterval: 60_000,
    });
    const claude = quotagate.wrap(createMockAnthropic());
    await claude.messages.create(baseParams, { quotagate: { traceId: 't-shutdown' } });
    await new Promise((r) => setImmediate(r));
    await quotagate.shutdown();
    expect(received.flatMap((r) => r.body.spans).map((s) => s.traceId)).toEqual(['t-shutdown']);
  });
});
