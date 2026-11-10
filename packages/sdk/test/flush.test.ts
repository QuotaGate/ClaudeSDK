// Task 1.4 — Event buffer and flush worker
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RingBuffer } from '../src/buffer.js';
import { FlushWorker, MAX_SPANS_PER_REQUEST } from '../src/flush-worker.js';
import { QuotaGate } from '../src/index.js';
import { baseParams, createMockAnthropic, decodeBody, okFetch, tick } from './helpers.js';

const workerOpts = {
  url: 'http://ingest.test/v1/ingest',
  apiKey: 'lb_test_key',
  projectId: 'proj_test',
  sdkVersion: '0.1.0',
  compress: false,
};

const realSetTimeout = globalThis.setTimeout;
const realSleep = (ms: number) => new Promise<void>((r) => realSetTimeout(r, ms));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('RingBuffer', () => {
  it('(1) drops the oldest item when full and logs to stderr', () => {
    const logs: string[] = [];
    const buf = new RingBuffer<number>(3, (m) => logs.push(m));
    [1, 2, 3].forEach((n) => buf.push(n));
    expect(buf.push(4)).toBe(1);
    expect(buf.size).toBe(3);
    expect(buf.dropped).toBe(1);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('buffer full');
    expect(buf.drain()).toEqual([2, 3, 4]);
  });

  it('writes the drop notice to stderr by default', () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const buf = new RingBuffer<number>(1);
    buf.push(1);
    buf.push(2);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('[quotagate] event buffer full'));
  });

  it('defaults to 1,000 items', () => {
    const buf = new RingBuffer<number>(undefined, () => {});
    for (let i = 0; i < 1005; i++) buf.push(i);
    const items = buf.drain();
    expect(items).toHaveLength(1000);
    expect(items[0]).toBe(5);
  });

  it('drain() returns all items oldest-first and clears the buffer', () => {
    const buf = new RingBuffer<string>(5);
    buf.push('a');
    buf.push('b');
    expect(buf.drain()).toEqual(['a', 'b']);
    expect(buf.size).toBe(0);
    expect(buf.drain()).toEqual([]);
  });
});

describe('FlushWorker', () => {
  it('(2) flushes on the 2,000 ms timer', async () => {
    vi.useFakeTimers();
    const { fn, bodies } = okFetch();
    const buf = new RingBuffer<object>(1000);
    const worker = new FlushWorker(buf, { ...workerOpts, fetch: fn });
    worker.start();
    buf.push({ spanId: 's1' });
    worker.notify();

    await vi.advanceTimersByTimeAsync(1999);
    expect(fn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(bodies[0]!.spans).toEqual([{ spanId: 's1' }]);
    worker.stop();
  });

  it('(3) flushes as soon as the buffer reaches 100 items', async () => {
    vi.useFakeTimers();
    const { fn, bodies } = okFetch();
    const buf = new RingBuffer<object>(1000);
    const worker = new FlushWorker(buf, { ...workerOpts, fetch: fn });
    worker.start();
    for (let i = 0; i < 99; i++) {
      buf.push({ i });
      worker.notify();
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).not.toHaveBeenCalled();
    buf.push({ i: 99 });
    worker.notify();
    await vi.advanceTimersByTimeAsync(0); // well before the 2s timer
    expect(fn).toHaveBeenCalledTimes(1);
    expect(bodies[0]!.spans).toHaveLength(100);
    worker.stop();
  });

  it('sends sdkVersion and projectId in every request body, with the API key as a Bearer token', async () => {
    const { fn, bodies } = okFetch();
    const buf = new RingBuffer<object>(10);
    const worker = new FlushWorker(buf, { ...workerOpts, fetch: fn });
    buf.push({ spanId: 'a' });
    await worker.flush();
    buf.push({ spanId: 'b' });
    await worker.flush();
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body.sdkVersion).toBe('0.1.0');
      expect(body.projectId).toBe('proj_test');
    }
    const init = fn.mock.calls[0]![1]!;
    expect(fn.mock.calls[0]![0]).toBe('http://ingest.test/v1/ingest');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer lb_test_key');
  });

  it('gzips request bodies by default', async () => {
    const { fn, bodies } = okFetch();
    const buf = new RingBuffer<object>(10);
    const worker = new FlushWorker(buf, { ...workerOpts, compress: true, fetch: fn });
    buf.push({ spanId: 'gz' });
    await worker.flush();
    const init = fn.mock.calls[0]![1]!;
    expect((init.headers as Record<string, string>)['content-encoding']).toBe('gzip');
    expect(decodeBody(init).spans).toEqual([{ spanId: 'gz' }]);
    expect(bodies).toHaveLength(1);
  });

  it(`splits large drains into requests of at most ${MAX_SPANS_PER_REQUEST} spans`, async () => {
    const { fn, bodies } = okFetch();
    const buf = new RingBuffer<object>(1000);
    const worker = new FlushWorker(buf, { ...workerOpts, fetch: fn });
    for (let i = 0; i < 450; i++) buf.push({ i });
    await worker.flush();
    expect(bodies.map((b) => b.spans.length)).toEqual([200, 200, 50]);
  });

  it('retries with exponential backoff (1s, 2s, 4s) and succeeds on a later attempt', async () => {
    vi.useFakeTimers();
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const logs: string[] = [];
    const buf = new RingBuffer<object>(10);
    const worker = new FlushWorker(buf, {
      ...workerOpts,
      fetch: fetchFn,
      logger: (m) => logs.push(m),
    });
    buf.push({ spanId: 'x' });
    const done = worker.flush();

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    await done;
    expect(logs).toEqual([]);
  });

  it('(4) retry exhaustion logs to stderr, discards the batch and never throws', async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('ECONNREFUSED'));
    const logs: string[] = [];
    const buf = new RingBuffer<object>(10);
    const worker = new FlushWorker(buf, {
      ...workerOpts,
      fetch: fetchFn,
      logger: (m) => logs.push(m),
    });
    buf.push({ spanId: 'lost' });

    const done = worker.flush();
    await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000);
    await expect(done).resolves.toBeUndefined();
    expect(fetchFn).toHaveBeenCalledTimes(4); // initial attempt + 3 retries
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/failed to deliver 1 span\(s\).*ECONNREFUSED.*discarded/);
    expect(buf.size).toBe(0);
  });

  it('does not retry non-retryable 4xx responses (e.g. invalid API key)', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 401 }));
    const logs: string[] = [];
    const buf = new RingBuffer<object>(10);
    const worker = new FlushWorker(buf, {
      ...workerOpts,
      fetch: fetchFn,
      logger: (m) => logs.push(m),
    });
    buf.push({});
    await worker.flush();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(logs[0]).toContain('HTTP 401');
  });

  it('logs spans rejected by the backend (partial success)', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ accepted: 1, rejected: 1, errors: [{ spanId: 'b' }] })),
      );
    const logs: string[] = [];
    const buf = new RingBuffer<object>(10);
    const worker = new FlushWorker(buf, {
      ...workerOpts,
      fetch: fetchFn,
      logger: (m) => logs.push(m),
    });
    buf.push({});
    await worker.flush();
    expect(logs[0]).toContain('rejected 1 span');
  });

  it('a throwing fetch implementation never escapes', async () => {
    const fetchFn = vi.fn(() => {
      throw new Error('sync explosion');
    }) as unknown as typeof fetch;
    const buf = new RingBuffer<object>(10);
    const worker = new FlushWorker(buf, {
      ...workerOpts,
      fetch: fetchFn,
      retryDelaysMs: [],
      logger: () => {},
    });
    buf.push({});
    await expect(worker.flush()).resolves.toBeUndefined();
  });
});

describe('QuotaGate end-to-end flush behaviour', () => {
  it('(5) application code is never blocked by flush (backend hangs forever)', async () => {
    let fetchCalls = 0;
    const hangingFetch = vi.fn(() => {
      fetchCalls++;
      return new Promise<Response>(() => {}); // never settles
    }) as unknown as typeof fetch;
    const quotagate = new QuotaGate(
      { apiKey: 'k', projectId: 'p', fetch: hangingFetch, flushBatchSize: 1 },
      { logger: () => {} },
    );
    const anthropic = createMockAnthropic();
    const claude = quotagate.wrap(anthropic);

    const t0 = performance.now();
    for (let i = 0; i < 5; i++) await claude.messages.create(baseParams);
    const elapsed = performance.now() - t0;
    await vi.waitFor(() => expect(fetchCalls).toBeGreaterThan(0), { timeout: 2000 });

    expect(fetchCalls).toBeGreaterThan(0); // flush really is in flight...
    expect(elapsed).toBeLessThan(100); // ...yet every call returned immediately
    expect(anthropic.messages.create).toHaveBeenCalledTimes(5);
    void quotagate.shutdown(); // the mock fetch ignores its abort signal, so do not await
  }, 5000);

  it('a failing backend never throws into application code', async () => {
    // Only fake timeouts/intervals: gzip runs on the libuv thread pool and needs real loop turns.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const failingFetch = vi.fn<typeof fetch>().mockRejectedValue(new Error('down'));
    const logs: string[] = [];
    const quotagate = new QuotaGate(
      { apiKey: 'k', projectId: 'p', fetch: failingFetch },
      { logger: (m) => logs.push(m) },
    );
    const claude = quotagate.wrap(createMockAnthropic());
    await expect(claude.messages.create(baseParams)).resolves.toBeDefined();
    // Interval flush (2s) + retries (1s, 2s, 4s); give gzip real time between fake steps.
    for (let i = 0; i < 200 && failingFetch.mock.calls.length < 4; i++) {
      await vi.advanceTimersByTimeAsync(250);
      await realSleep(5);
    }
    expect(failingFetch).toHaveBeenCalledTimes(4);
    expect(logs.some((l) => l.includes('failed to deliver'))).toBe(true);
    await quotagate.shutdown();
  });

  it('does not export (and does not throw) when apiKey/projectId are missing', async () => {
    const logs: string[] = [];
    const fetchFn = vi.fn<typeof fetch>();
    const quotagate = new QuotaGate(
      { apiKey: undefined, fetch: fetchFn },
      { logger: (m) => logs.push(m) },
    );
    expect(quotagate.exporting).toBe(false);
    expect(logs[0]).toContain('will not be exported');
    const claude = quotagate.wrap(createMockAnthropic());
    await claude.messages.create(baseParams);
    await tick();
    await quotagate.flush();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
