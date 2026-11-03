// Task 1.6 — quotagateNoop
import { afterEach, describe, expect, it, vi } from 'vitest';
import { quotagateNoop } from '../src/index.js';
import { RingBuffer } from '../src/buffer.js';
import { FlushWorker } from '../src/flush-worker.js';
import { PolicyEngine } from '../src/policy/engine.js';
import { Tracer } from '../src/span.js';
import { baseParams, createMockAnthropic, mockMessage } from './helpers.js';

describe('quotagateNoop()', () => {
  afterEach(() => vi.restoreAllMocks());

  it('calls straight through to the real Anthropic without executing QuotaGate code', async () => {
    const spies = [
      vi.spyOn(Tracer.prototype, 'start'),
      vi.spyOn(PolicyEngine.prototype, 'evaluate'),
      vi.spyOn(RingBuffer.prototype, 'push'),
      vi.spyOn(FlushWorker.prototype, 'flush'),
    ];
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const message = mockMessage();
    const anthropic = createMockAnthropic(message);

    const claude = quotagateNoop().wrap(anthropic);
    const response = await claude.messages.create(baseParams, { quotagate: { traceId: 't' } });

    expect(claude).toBe(anthropic);
    expect(response).toBe(message);
    expect(anthropic.messages.create).toHaveBeenCalledWith(baseParams, {
      quotagate: { traceId: 't' },
    });
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('has the same wrap() shape as QuotaGate and creates no timers', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const noop = quotagateNoop();
    expect(typeof noop.wrap).toBe('function');
    noop.wrap(createMockAnthropic());
    expect(setIntervalSpy).not.toHaveBeenCalled();
  });
});
