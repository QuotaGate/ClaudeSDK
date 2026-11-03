// Task 1.3 — Span capture
import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { QuotaGateClient } from '../src/index.js';
import {
  MockMessageStream,
  MockRawStream,
  baseParams,
  createMockAnthropic,
  makeTracer,
  mockMessage,
  streamEventsFor,
  tick,
} from './helpers.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('span capture: non-streaming', () => {
  it('populates every span field from params and the response', async () => {
    const message = mockMessage();
    const anthropic = createMockAnthropic(message);
    anthropic.messages.create.mockImplementationOnce(
      () => new Promise((r) => setTimeout(() => r(message), 25)),
    );
    const { tracer, spans } = makeTracer();
    const client = new QuotaGateClient(anthropic, tracer);

    const params = { ...baseParams, system: 'You are a contract analyst.' };
    await client.messages.create(params, {
      quotagate: {
        traceId: 'trace_abc123',
        agentId: 'contract-review-agent',
        taskLabel: 'contract-summary',
        metadata: { contractId: 'CTR-2026-001' },
      },
    });
    await tick();

    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.spanId).toMatch(UUID_V4);
    expect(span.traceId).toBe('trace_abc123');
    expect(span.parentSpanId).toBeNull();
    expect(span.agentId).toBe('contract-review-agent');
    expect(span.taskLabel).toBe('contract-summary');
    expect(span.metadata).toEqual({ contractId: 'CTR-2026-001' });
    expect(span.model).toBe('claude-opus-4-5');
    expect(span.system).toBe('You are a contract analyst.');
    expect(span.messages).toEqual(params.messages);
    expect(span.response).toEqual(message);
    expect(span.inputTokens).toBe(120);
    expect(span.outputTokens).toBe(45);
    expect(span.cacheWriteTokens).toBe(10);
    expect(span.cacheReadTokens).toBe(30);
    expect(span.stopReason).toBe('end_turn');
    expect(span.errorMessage).toBeNull();
    expect(span.streamed).toBe(false);
    expect(span.captureContent).toBe(true);
    expect(span.startedAt).toBeInstanceOf(Date);
    expect(span.completedAt.getTime()).toBeGreaterThanOrEqual(span.startedAt.getTime());
    expect(span.latencyMs).toBe(span.completedAt.getTime() - span.startedAt.getTime());
    expect(span.latencyMs).toBeGreaterThanOrEqual(20);
    expect(span.sdkVersion).toBe('0.1.0-dev');
  });

  it('generates a UUID traceId when none is supplied', async () => {
    const { tracer, spans } = makeTracer();
    const client = new QuotaGateClient(createMockAnthropic(), tracer);
    await client.messages.create(baseParams);
    await tick();
    expect(spans[0]!.traceId).toMatch(UUID_V4);
  });

  it('joins array system prompts and records tool calls', async () => {
    const message = mockMessage({
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'Looking it up.', citations: null },
        { type: 'tool_use', id: 'toolu_1', name: 'lookup_clause', input: { clause: '4.2' } },
      ] as Anthropic.ContentBlock[],
    });
    const { tracer, spans } = makeTracer();
    const client = new QuotaGateClient(createMockAnthropic(message), tracer);
    await client.messages.create({
      ...baseParams,
      system: [
        { type: 'text', text: 'Part one.' },
        { type: 'text', text: 'Part two.' },
      ],
    });
    await tick();
    expect(spans[0]!.system).toBe('Part one.\nPart two.');
    expect(spans[0]!.stopReason).toBe('tool_use');
    expect(spans[0]!.toolCalls).toEqual([
      {
        toolCallId: 'toolu_1',
        toolName: 'lookup_clause',
        toolInput: { clause: '4.2' },
        toolResult: null,
        childSpanId: null,
      },
    ]);
  });

  it('snapshots the messages array (later pushes by the app do not leak into the span)', async () => {
    const { tracer, spans } = makeTracer();
    const client = new QuotaGateClient(createMockAnthropic(), tracer);
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: 'hi' }];
    const res = await client.messages.create({ ...baseParams, messages });
    messages.push({ role: 'assistant', content: res.content });
    await tick();
    expect(spans[0]!.messages).toHaveLength(1);
  });

  it('records an error span when the Anthropic call fails', async () => {
    const anthropic = createMockAnthropic();
    anthropic.messages.create.mockRejectedValueOnce(new Error('429 rate_limit_error'));
    const { tracer, spans } = makeTracer();
    const client = new QuotaGateClient(anthropic, tracer);
    await expect(client.messages.create(baseParams)).rejects.toThrow('429');
    await tick();
    expect(spans[0]).toMatchObject({
      stopReason: 'error',
      errorMessage: '429 rate_limit_error',
      response: null,
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  it('strips content when captureContent is false (D9 opt-out)', async () => {
    const { tracer, spans } = makeTracer({ captureContent: false });
    const client = new QuotaGateClient(createMockAnthropic(), tracer);
    await client.messages.create({ ...baseParams, system: 'secret system prompt' });
    await tick();
    const span = spans[0]!;
    expect(span.captureContent).toBe(false);
    expect(span.messages).toEqual([]);
    expect(span.system).toBeNull();
    expect(span.response?.content).toEqual([]);
    expect(span.inputTokens).toBe(120);
    expect(JSON.stringify(span)).not.toContain('Summarize this contract');
  });

  it('builds the span after the caller already has its response (not on the critical path)', async () => {
    const { tracer, spans } = makeTracer();
    const client = new QuotaGateClient(createMockAnthropic(), tracer);
    await client.messages.create(baseParams);
    expect(spans).toHaveLength(0); // deferred
    await tick();
    expect(spans).toHaveLength(1);
  });
});

describe('span capture: streaming', () => {
  it('create({ stream: true }): passes chunks through unchanged and captures on message_stop', async () => {
    const message = mockMessage();
    const events = streamEventsFor(message);
    const anthropic = createMockAnthropic(message);
    const rawStream = new MockRawStream(events);
    anthropic.messages.create.mockResolvedValueOnce(rawStream);
    const { tracer, spans } = makeTracer();
    const client = new QuotaGateClient(anthropic, tracer);

    const before = Date.now();
    const stream = await client.messages.create(
      { ...baseParams, stream: true },
      { quotagate: { traceId: 'trace_stream', taskLabel: 'clause-review' } },
    );
    expect(stream).toBe(rawStream);

    const received: unknown[] = [];
    for await (const chunk of stream) received.push(chunk);
    expect(received).toEqual(events);
    for (let i = 0; i < events.length; i++) expect(received[i]).toBe(events[i]);

    await tick();
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.streamed).toBe(true);
    expect(span.traceId).toBe('trace_stream');
    expect(span.startedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(span.inputTokens).toBe(120);
    expect(span.outputTokens).toBe(45);
    expect(span.cacheReadTokens).toBe(30);
    expect(span.cacheWriteTokens).toBe(10);
    expect(span.stopReason).toBe('end_turn');
    expect(span.response?.content).toEqual([{ type: 'text', text: 'Here is the summary.' }]);
    expect(span.latencyMs).toBe(span.completedAt.getTime() - span.startedAt.getTime());
  });

  it('reassembles tool_use input from input_json_delta chunks', async () => {
    const message = mockMessage({
      stop_reason: 'tool_use',
      content: [
        { type: 'tool_use', id: 'toolu_9', name: 'search', input: { q: 'indemnity cap' } },
      ] as Anthropic.ContentBlock[],
    });
    const { tracer, spans } = makeTracer();
    const client = new QuotaGateClient(createMockAnthropic(message), tracer);
    const stream = await client.messages.create({ ...baseParams, stream: true });
    for await (const _event of stream) {
      void _event;
      // consume
    }
    await tick();
    expect(spans[0]!.toolCalls[0]).toMatchObject({
      toolName: 'search',
      toolInput: { q: 'indemnity cap' },
    });
  });

  it('records a partial error span when the consumer stops before message_stop', async () => {
    const { tracer, spans } = makeTracer();
    const client = new QuotaGateClient(createMockAnthropic(), tracer);
    const stream = await client.messages.create({ ...baseParams, stream: true });
    for await (const _event of stream) {
      void _event;
      break;
    }
    await tick();
    expect(spans[0]).toMatchObject({ stopReason: 'error', inputTokens: 120 });
    expect(spans[0]!.errorMessage).toContain('cancelled');
  });

  it('messages.stream(): captures the final message via stream events', async () => {
    const message = mockMessage();
    const { tracer, spans } = makeTracer();
    const anthropic = createMockAnthropic(message);
    const client = new QuotaGateClient(anthropic, tracer);

    const stream = await client.messages.stream(baseParams, {
      quotagate: { agentId: 'contract-review-agent', taskLabel: 'clause-review' },
    });
    let text = '';
    for await (const chunk of stream as unknown as AsyncIterable<Record<string, unknown>>) {
      if (chunk.type === 'content_block_delta') text += (chunk.delta as { text: string }).text;
    }
    expect(text).toBe('Here is the summary.');
    await tick();

    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      streamed: true,
      agentId: 'contract-review-agent',
      taskLabel: 'clause-review',
      inputTokens: 120,
      outputTokens: 45,
      stopReason: 'end_turn',
      errorMessage: null,
    });
    expect(spans[0]!.response).toBe(message);
  });

  it('messages.stream(): records an error span when the stream fails', async () => {
    const message = mockMessage();
    const anthropic = createMockAnthropic(message);
    anthropic.messages.stream.mockReturnValueOnce(
      new MockMessageStream(
        streamEventsFor(message).slice(0, 2),
        message,
        new Error('connection reset'),
      ),
    );
    const { tracer, spans } = makeTracer();
    const client = new QuotaGateClient(anthropic, tracer);
    const stream = client.messages.stream(baseParams);
    await expect(
      (async () => {
        for await (const _event of stream as unknown as AsyncIterable<unknown>) {
          void _event;
          // consume
        }
      })(),
    ).rejects.toThrow('connection reset');
    await tick();
    expect(spans[0]).toMatchObject({ stopReason: 'error', streamed: true });
  });
});
