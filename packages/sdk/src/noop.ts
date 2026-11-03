export interface QuotaGateNoop {
  /** Returns the Anthropic client itself: no buffer, no flush, no policy evaluation. */
  wrap<T>(anthropic: T): T;
}

/**
 * No-op QuotaGate for tests and opt-out environments. Same `.wrap()` shape as QuotaGate,
 * zero side effects. `wrap()` returns the original client, so every call goes straight to
 * the Anthropic SDK; the SDK ignores the `quotagate` request option.
 */
export function quotagateNoop(): QuotaGateNoop {
  return { wrap: <T>(anthropic: T): T => anthropic };
}
