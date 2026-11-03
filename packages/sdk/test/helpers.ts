import { gunzipSync } from 'node:zlib';
import { vi, type Mock } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { Tracer } from '../src/span.js';
import { PolicyEngine } from '../src/policy/engine.js';
import type { Policy, Span } from '../src/types.js';

export const baseParams = {
  model: 'claude-opus-4-5',
  max_tokens: 1024,
  messages: [{ role: 'user' as const, content: 'Summarize this contract.' }],
};

export function mockMessage(overrides: Partial<Anthropic.Message> = {}): Anthropic.Message {
  return {
    id: 'msg_01',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-4-5',
    content: [{ type: 'text', text: 'Here is the summary.', citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 120,
      output_tokens: 45,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 30,
    },
    ...overrides,
  } as Anthropic.Message;
}

/** Raw stream events that reconstruct `message`. */
export function streamEventsFor(message: Anthropic.Message): Record<string, unknown>[] {
  const { content, usage, stop_reason, ...rest } = message;
  const events: Record<string, unknown>[] = [
    {
      type: 'message_start',
      message: {
        ...rest,
        content: [],
        stop_reason: null,
        usage: { ...usage, output_tokens: 1 },
      },
    },
  ];
  content.forEach((block, index) => {
    if (block.type === 'text') {
      events.push({
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '' },
      });
      const mid = Math.ceil(block.text.length / 2);
      for (const part of [block.text.slice(0, mid), block.text.slice(mid)]) {
        events.push({
          type: 'content_block_delta',
          index,
          delta: { type: 'text_delta', text: part },
        });
      }
    } else if (block.type === 'tool_use') {
      events.push({
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
      });
      const json = JSON.stringify(block.input);
      events.push({
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: json.slice(0, 5) },
      });
      events.push({
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: json.slice(5) },
      });
    }
    events.push({ type: 'content_block_stop', index });
  });
  events.push({
    type: 'message_delta',
    delta: { stop_reason, stop_sequence: null },
    usage: { output_tokens: usage.output_tokens },
  });
  events.push({ type: 'message_stop' });
  return events;
}

/** Minimal stand-in for the SDK's Stream<RawMessageStreamEvent>: an async iterable. */
export class MockRawStream {
  constructor(private readonly events: unknown[]) {}
  async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
    for (const e of this.events) {
      await Promise.resolve();
      yield e;
    }
  }
}

/** Minimal stand-in for the SDK's MessageStream: events + async iteration. */
export class MockMessageStream {
  private listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
  constructor(
    private readonly events: unknown[],
    private readonly final: Anthropic.Message,
    private readonly failWith?: Error,
  ) {}
  on(event: string, fn: (...a: unknown[]) => void): this {
    (this.listeners[event] ??= []).push(fn);
    return this;
  }
  private emit(event: string, ...args: unknown[]): void {
    for (const fn of this.listeners[event] ?? []) fn(...args);
  }
  async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
    for (const e of this.events) {
      await Promise.resolve();
      yield e;
    }
    if (this.failWith) {
      this.emit('end');
      throw this.failWith;
    }
    this.emit('finalMessage', this.final);
    this.emit('end');
  }
  async finalMessage(): Promise<Anthropic.Message> {
    for await (const _event of this) {
      void _event;
      // drain
    }
    return this.final;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mocks accept any call shape
type MockFn = Mock<(...args: any[]) => any>;

export interface MockAnthropic {
  messages: {
    create: MockFn;
    stream: MockFn;
    countTokens: MockFn;
  };
  models: { list: MockFn };
  apiKey: string;
}

export function createMockAnthropic(message: Anthropic.Message = mockMessage()): MockAnthropic {
  return {
    apiKey: 'sk-test-not-real',
    messages: {
      create: vi.fn(async (params: { stream?: boolean }) =>
        params.stream ? new MockRawStream(streamEventsFor(message)) : message,
      ),
      stream: vi.fn(() => new MockMessageStream(streamEventsFor(message), message)),
      countTokens: vi.fn(async () => ({ input_tokens: 42 })),
    },
    models: { list: vi.fn(async () => ({ data: [] })) },
  };
}

/** Lets deferred span building (setImmediate) run. */
export function tick(times = 2): Promise<void> {
  let p = Promise.resolve();
  for (let i = 0; i < times; i++) p = p.then(() => new Promise<void>((r) => setImmediate(r)));
  return p;
}

export function makeTracer(opts: { policies?: Policy[]; captureContent?: boolean } = {}) {
  const spans: Span[] = [];
  const logs: string[] = [];
  const logger = (m: string) => void logs.push(m);
  const tracer = new Tracer({
    policyEngine: new PolicyEngine(opts.policies ?? [], { logger }),
    record: (s) => void spans.push(s),
    captureContent: opts.captureContent ?? true,
    onPolicyError: 'log',
    logger,
  });
  return { tracer, spans, logs };
}

export interface IngestBody {
  sdkVersion: string;
  projectId: string;
  spans: Record<string, unknown>[];
}

/** Decodes a request body sent by the flush worker (gzip or plain JSON). */
export function decodeBody(init: RequestInit | undefined): IngestBody {
  const body = init?.body;
  const headers = (init?.headers ?? {}) as Record<string, string>;
  const raw =
    headers['content-encoding'] === 'gzip'
      ? gunzipSync(body as Uint8Array).toString('utf8')
      : String(body);
  return JSON.parse(raw) as IngestBody;
}

/** A fetch mock that records requests and answers 200. */
export function okFetch() {
  const bodies: IngestBody[] = [];
  const fn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(decodeBody(init));
    return new Response(JSON.stringify({ accepted: 1, rejected: 0, errors: [] }), { status: 200 });
  });
  return { fn, bodies };
}
