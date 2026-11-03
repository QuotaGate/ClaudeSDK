import type { QuotaGateContext } from './types.js';
import type { SpanHandle, Tracer } from './span.js';
import { PolicyViolationError } from './policy/errors.js';
import { isRecord, isThenable } from './internal/util.js';

/** Minimal structural shape of an Anthropic client that QuotaGate can wrap. */
export interface AnthropicLike {
  messages: object;
}

type AnyFn = (...args: unknown[]) => unknown;

/**
 * Proxy client around a real Anthropic instance. `messages.create()`, `messages.stream()`
 * and `messages.parse()` keep the exact Anthropic signatures and return values; params
 * are passed through unchanged (only the `quotagate` request option is removed).
 * Without a tracer it is a pure pass-through.
 */
export class QuotaGateClient<T extends AnthropicLike> {
  readonly messages: T['messages'];

  constructor(
    readonly anthropic: T,
    tracer?: Tracer,
  ) {
    this.messages = wrapMessages(anthropic.messages, tracer) as T['messages'];
  }
}

/** Returns a Proxy of `anthropic` whose `messages` resource is instrumented. Typed as T. */
export function wrapAnthropic<T extends AnthropicLike>(anthropic: T, tracer: Tracer): T {
  const client = new QuotaGateClient(anthropic, tracer);
  return new Proxy(anthropic, {
    get(target, prop) {
      if (prop === 'messages') return client.messages;
      const value: unknown = Reflect.get(target, prop);
      // Bind methods to the real instance so private class fields keep working.
      return typeof value === 'function' ? (value as AnyFn).bind(target) : value;
    },
  });
}

function wrapMessages(messages: object, tracer: Tracer | undefined): object {
  const real = messages as Record<string | symbol, unknown>;
  const instrumented: Record<string, AnyFn> = {
    create: (params, options) => instrumentCall(real, 'create', params, options, tracer),
    parse: (params, options) => instrumentCall(real, 'parse', params, options, tracer),
    stream: (params, options) => instrumentMessageStream(real, params, options, tracer),
  };
  return new Proxy(messages, {
    get(target, prop) {
      if (typeof prop === 'string' && prop in instrumented && typeof real[prop] === 'function') {
        return instrumented[prop];
      }
      const value: unknown = Reflect.get(target, prop);
      return typeof value === 'function' ? (value as AnyFn).bind(target) : value;
    },
  });
}

/** Splits `{ quotagate, ...requestOptions }`. The real SDK never sees `quotagate`. */
function splitOptions(options: unknown): { ctx?: QuotaGateContext; args: unknown[] } {
  if (!isRecord(options)) return { args: options === undefined ? [] : [options] };
  if (!('quotagate' in options)) return { args: [options] };
  const { quotagate, ...rest } = options;
  return { ctx: isRecord(quotagate) ? (quotagate as QuotaGateContext) : undefined, args: [rest] };
}

function begin(
  tracer: Tracer | undefined,
  params: unknown,
  ctx: QuotaGateContext | undefined,
  streamed: boolean,
): { handle?: SpanHandle; blocked?: PolicyViolationError } {
  if (!tracer) return {};
  try {
    return { handle: tracer.start(params, ctx, streamed) };
  } catch (err) {
    if (err instanceof PolicyViolationError) return { blocked: err };
    return {};
  }
}

/** messages.create / messages.parse: returns the real (API)Promise object untouched. */
function instrumentCall(
  real: Record<string | symbol, unknown>,
  method: 'create' | 'parse',
  params: unknown,
  options: unknown,
  tracer: Tracer | undefined,
): unknown {
  const { ctx, args } = splitOptions(options);
  const streamed = isRecord(params) && params.stream === true;
  const { handle, blocked } = begin(tracer, params, ctx, streamed);
  if (blocked) return Promise.reject(blocked);

  let result: unknown;
  try {
    result = (real[method] as AnyFn).call(real, params, ...args);
  } catch (err) {
    handle?.fail(err);
    throw err;
  }
  if (handle && isThenable(result)) {
    // Observe without altering what the caller receives. Registered before the
    // caller's own handlers, so a stream is instrumented before it is iterated.
    result.then(
      (value) => {
        if (streamed) instrumentAsyncIterable(value, handle);
        else handle.complete(value);
      },
      (err: unknown) => handle.fail(err),
    );
  } else if (handle) {
    handle.complete(result);
  }
  return result;
}

/** messages.stream(): returns the real MessageStream; capture via its events. */
function instrumentMessageStream(
  real: Record<string | symbol, unknown>,
  params: unknown,
  options: unknown,
  tracer: Tracer | undefined,
): unknown {
  const { ctx, args } = splitOptions(options);
  const { handle, blocked } = begin(tracer, params, ctx, true);
  if (blocked) throw blocked; // messages.stream() is synchronous in the Anthropic SDK

  let stream: unknown;
  try {
    stream = (real.stream as AnyFn).call(real, params, ...args);
  } catch (err) {
    handle?.fail(err);
    throw err;
  }
  if (!handle) return stream;

  const emitter = stream as { on?: (event: string, fn: AnyFn) => unknown };
  if (typeof emitter?.on === 'function') {
    // Only 'finalMessage' and 'end' are observed: attaching 'error'/'abort' listeners
    // would change the SDK's unhandled-rejection behaviour for the application.
    emitter.on('finalMessage', (message: unknown) => handle.complete(message));
    emitter.on('end', () => handle.endStream('stream errored or was aborted'));
  } else {
    instrumentAsyncIterable(stream, handle);
  }
  return stream;
}

/**
 * Instruments an async-iterable stream of raw events in place: every chunk is passed
 * through unchanged (no buffering); the span completes on message_stop.
 */
function instrumentAsyncIterable(stream: unknown, handle: SpanHandle): void {
  const iterable = stream as Record<symbol, unknown> | null;
  const original = iterable?.[Symbol.asyncIterator];
  if (typeof original !== 'function') {
    handle.complete(stream);
    return;
  }
  try {
    Object.defineProperty(iterable, Symbol.asyncIterator, {
      configurable: true,
      writable: true,
      value: function instrumentedIterator(this: unknown) {
        const it = (original as AnyFn).call(iterable) as AsyncIterator<unknown>;
        const wrapped: AsyncIterableIterator<unknown> = {
          async next(...a: [] | [unknown]) {
            let r: IteratorResult<unknown>;
            try {
              r = await it.next(...a);
            } catch (err) {
              handle.fail(err);
              throw err;
            }
            if (r.done) handle.endStream();
            else handle.onStreamEvent(r.value);
            return r;
          },
          async return(value?: unknown) {
            handle.endStream('stream cancelled before message_stop');
            return it.return ? it.return(value) : { done: true, value };
          },
          async throw(err?: unknown) {
            handle.fail(err);
            if (it.throw) return it.throw(err);
            throw err;
          },
          [Symbol.asyncIterator]() {
            return wrapped;
          },
        };
        return wrapped;
      },
    });
  } catch {
    // Frozen/non-configurable stream: leave it untouched; the span is recorded without usage.
    handle.endStream('stream could not be instrumented');
  }
}
