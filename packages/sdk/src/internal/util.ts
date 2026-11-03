import { randomUUID } from 'node:crypto';

/** UUID v4. */
export const uuid = (): string => randomUUID();

export type Logger = (message: string) => void;

/** Default logger: stderr, prefixed. */
export const stderrLogger: Logger = (message) => {
  console.error(`[quotagate] ${message}`);
};

/** Runs `fn` after the current turn of the event loop, off the caller's critical path. */
export function defer(fn: () => void): void {
  if (typeof setImmediate === 'function') setImmediate(fn);
  else setTimeout(fn, 0);
}

/** Like setTimeout, but the timer never keeps the process alive. */
export function sleepUnref(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as { unref?: () => void }).unref?.();
  });
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return 'unknown error';
  }
}

export function isThenable(v: unknown): v is PromiseLike<unknown> {
  return (
    v !== null &&
    (typeof v === 'object' || typeof v === 'function') &&
    typeof (v as { then?: unknown }).then === 'function'
  );
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
