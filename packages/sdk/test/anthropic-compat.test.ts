/**
 * Drop-in compatibility against the real @anthropic-ai/sdk client. The Anthropic client is
 * given a mocked `fetch`, so no request leaves the process and no API key is needed.
 */
import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { QuotaGate, PolicyViolationError } from '../src/index.js';
import type { Span } from '../src/types.js';
import { baseParams, mockMessage, streamEventsFor } from './helpers.js';

const message = mockMessage({ id: 'msg_real_sdk' });

function sse(events: Record<string, unknown>[]): string {
  return events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

/** Fake Anthropic HTTP API: JSON for normal calls, SSE when `stream: true`. */
function anthropicFetch() {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { stream?: boolean };
    if (body.stream) {
      return new Response(sse(streamEventsFor(message)), {
        headers: { 'content-type': 'text/event-stream', 'request-id': 'req_1' },
      });
    }
    return new Response(JSON.stringify(message), {
      headers: { 'content-type': 'application/json', 'request-id': 'req_1' },
    });
  });
}

function setup(options: ConstructorParameters<typeof QuotaGate>[0] = {}) {
  const fetchFn = anthropicFetch();
  const anthropic = new Anthropic({ apiKey: 'test-not-a-real-key', fetch: fetchFn, maxRetries: 0 });
  const quotagate = new QuotaGate(options, { logger: () => {} });
  const spans: Span[] = [];
  // Capture spans locally instead of exporting them.
  (quotagate as unknown as { record: (s: Span) => void }).record = (s) => void spans.push(s);
  const claude: Anthropic = quotagate.wrap(anthropic); // same static type: drop-in
  return { claude, anthropic, fetchFn, spans };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

describe('compatibility with the real Anthropic SDK client', () => {
  it('messages.create() returns the same response and records a span', async () => {
    const { claude, fetchFn, spans } = setup();
    const res = await claude.messages.create(baseParams, { quotagate: { traceId: 't1' } });
    expect(res).toEqual(message);
    // The `quotagate` option is stripped before the SDK sees the request options.
    const sentHeaders = new Headers(fetchFn.mock.calls[0]![1]!.headers);
    expect([...sentHeaders.keys()].some((k) => k.includes('quotagate'))).toBe(false);
    await settle();
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ traceId: 't1', inputTokens: 120, outputTokens: 45 });
  });

  it('APIPromise helpers keep working (.withResponse())', async () => {
    const { claude } = setup();
    const { data, response } = await claude.messages.create(baseParams).withResponse();
    expect(data.id).toBe('msg_real_sdk');
    expect(response.headers.get('request-id')).toBe('req_1');
  });

  it('create({ stream: true }) yields the SDK stream events and records a streamed span', async () => {
    const { claude, spans } = setup();
    const stream = await claude.messages.create({ ...baseParams, stream: true });
    let text = '';
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        text += event.delta.text;
      }
    }
    expect(text).toBe('Here is the summary.');
    await settle();
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ streamed: true, outputTokens: 45, stopReason: 'end_turn' });
  });

  it('messages.stream() works with finalMessage() and records a span', async () => {
    const { claude, spans } = setup();
    const stream = claude.messages.stream(baseParams, { quotagate: { traceId: 't-stream' } });
    const final = await stream.finalMessage();
    expect(final.content[0]).toMatchObject({ type: 'text', text: 'Here is the summary.' });
    await settle();
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ traceId: 't-stream', streamed: true });
  });

  it('non-messages resources pass through untouched', () => {
    const { claude, anthropic } = setup();
    expect(claude.models).toBe(anthropic.models);
    expect(claude.apiKey).toBe(anthropic.apiKey);
  });

  it('API errors propagate unchanged and are recorded on the span', async () => {
    const { claude, fetchFn, spans } = setup();
    fetchFn.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }),
        {
          status: 529,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    await expect(claude.messages.create(baseParams)).rejects.toBeInstanceOf(Anthropic.APIError);
    await settle();
    expect(spans[0]!.errorMessage).toContain('busy');
  });

  it('a blocking policy stops the call before any HTTP request', async () => {
    const { claude, fetchFn } = setup({
      policies: [
        {
          policyId: 'cap',
          name: 'cap',
          scope: 'project',
          rules: [{ type: 'token_budget', params: { maxOutputTokens: 10 } }],
        },
      ],
    });
    await expect(claude.messages.create(baseParams)).rejects.toBeInstanceOf(PolicyViolationError);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
