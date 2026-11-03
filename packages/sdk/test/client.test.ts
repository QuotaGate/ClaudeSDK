// Task 1.2 — Proxy client
import { describe, expect, it } from 'vitest';
import { QuotaGate, QuotaGateClient } from '../src/index.js';
import { baseParams, createMockAnthropic, makeTracer, mockMessage, tick } from './helpers.js';

describe('QuotaGateClient (pass-through)', () => {
  it('returns exactly what the mocked Anthropic instance returns', async () => {
    const message = mockMessage();
    const anthropic = createMockAnthropic(message);
    const client = new QuotaGateClient(anthropic);

    const response = await client.messages.create(baseParams);

    expect(response).toBe(message);
    expect(anthropic.messages.create).toHaveBeenCalledTimes(1);
    expect(anthropic.messages.create.mock.calls[0]![0]).toBe(baseParams);
  });

  it('passes params unchanged with a tracer attached, and returns the same promise object', async () => {
    const message = mockMessage();
    const anthropic = createMockAnthropic(message);
    const sentinel = Promise.resolve(message);
    anthropic.messages.create.mockReturnValueOnce(sentinel);
    const { tracer } = makeTracer();
    const client = new QuotaGateClient(anthropic, tracer);

    const returned = client.messages.create(baseParams);

    expect(returned).toBe(sentinel); // APIPromise helpers (.withResponse etc.) survive
    expect(await returned).toBe(message);
    expect(anthropic.messages.create.mock.calls[0]).toEqual([baseParams]);
    expect(anthropic.messages.create.mock.calls[0]![0]).toBe(baseParams);
    await tick();
  });

  it('strips only the quotagate option and forwards the other request options', async () => {
    const anthropic = createMockAnthropic();
    const { tracer } = makeTracer();
    const client = new QuotaGateClient(anthropic, tracer);

    await client.messages.create(baseParams, {
      timeout: 5000,
      headers: { 'x-test': '1' },
      quotagate: { traceId: 't1', agentId: 'a' },
    });

    expect(anthropic.messages.create.mock.calls[0]).toEqual([
      baseParams,
      { timeout: 5000, headers: { 'x-test': '1' } },
    ]);
    await tick();
  });

  it('exposes messages.stream() returning the real stream object', () => {
    const anthropic = createMockAnthropic();
    const { tracer } = makeTracer();
    const client = new QuotaGateClient(anthropic, tracer);
    const real = anthropic.messages.stream;

    const stream = client.messages.stream(baseParams, { quotagate: { agentId: 'a' } });

    expect(real).toHaveBeenCalledWith(baseParams, {});
    expect(stream).toBe(real.mock.results[0]!.value);
  });

  it('propagates Anthropic errors unchanged', async () => {
    const anthropic = createMockAnthropic();
    const boom = new Error('529 overloaded');
    anthropic.messages.create.mockRejectedValueOnce(boom);
    const { tracer } = makeTracer();
    const client = new QuotaGateClient(anthropic, tracer);

    await expect(client.messages.create(baseParams)).rejects.toBe(boom);
    await tick();
  });
});

describe('QuotaGate.wrap()', () => {
  it('is a drop-in proxy: other resources and properties pass through', async () => {
    const anthropic = createMockAnthropic();
    const claude = new QuotaGate({}, { logger: () => {} }).wrap(anthropic);

    expect(claude.apiKey).toBe('sk-test-not-real');
    await claude.models.list();
    expect(anthropic.models.list).toHaveBeenCalledTimes(1);
    await claude.messages.countTokens({ model: 'm', messages: [] });
    expect(anthropic.messages.countTokens).toHaveBeenCalledWith({ model: 'm', messages: [] });
  });

  it('keeps instanceof and binds methods to the real instance (private fields work)', async () => {
    class FakeAnthropic {
      #secret = 'ok';
      messages = createMockAnthropic().messages;
      reveal() {
        return this.#secret;
      }
    }
    const real = new FakeAnthropic();
    const claude = new QuotaGate({}, { logger: () => {} }).wrap(real);
    expect(claude).toBeInstanceOf(FakeAnthropic);
    expect(claude.reveal()).toBe('ok');
  });

  it('calls the real method with the original argument list when no options are given', async () => {
    const anthropic = createMockAnthropic();
    const claude = new QuotaGate({}, { logger: () => {} }).wrap(anthropic);
    await claude.messages.create(baseParams);
    expect(anthropic.messages.create.mock.calls[0]).toHaveLength(1);
  });
});
