/**
 * Claude list prices in USD per million tokens, used only for the pre-flight
 * cost_budget estimate. Authoritative cost is computed by the backend at ingest.
 *
 * Source: https://docs.claude.com/en/docs/about-claude/pricing (fetched 2026-10-29).
 * Models without a published price are intentionally absent; the SDK never guesses
 * a price (DECISIONS D7). Unknown models skip the cost_budget rule unless the rule
 * supplies `params.pricing`.
 */
export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  /** Long-context tier: higher prices when estimated input exceeds `aboveInputTokens`. */
  longContext?: { aboveInputTokens: number; inputPerMTok: number; outputPerMTok: number };
}

export const PRICING_SOURCE_DATE = '2026-10-29';

export const MODEL_PRICING: Readonly<Record<string, ModelPrice>> = {
  'claude-fable-5-1': { inputPerMTok: 10, outputPerMTok: 50 },
  'claude-mythos-5-1': { inputPerMTok: 10, outputPerMTok: 50 },
  'claude-opus-5-5': { inputPerMTok: 4, outputPerMTok: 20 },
  'claude-sonnet-5-5': { inputPerMTok: 2, outputPerMTok: 10 },
  'claude-haiku-5-5': {
    inputPerMTok: 0.1,
    outputPerMTok: 0.5,
    longContext: { aboveInputTokens: 100_000, inputPerMTok: 0.5, outputPerMTok: 2.5 },
  },
  'claude-fable-5': { inputPerMTok: 10, outputPerMTok: 50 },
  'claude-mythos-5': { inputPerMTok: 10, outputPerMTok: 50 },
  'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-sonnet-5': { inputPerMTok: 2, outputPerMTok: 10 },
  'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-7': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-6': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-5': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-1': { inputPerMTok: 15, outputPerMTok: 75 },
  'claude-opus-4': { inputPerMTok: 15, outputPerMTok: 75 },
  'claude-sonnet-4-6': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-sonnet-4-5': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-sonnet-4': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
  'claude-3-5-haiku': { inputPerMTok: 0.8, outputPerMTok: 4 },
};

/**
 * Resolves a model id to its price. Matches the exact alias or the alias plus a
 * dated snapshot suffix (e.g. claude-opus-4-5-20251101). 'claude-opus-4' does not
 * match an unknown 'claude-opus-4-9'.
 */
export function lookupModelPrice(model: string): ModelPrice | undefined {
  const exact = MODEL_PRICING[model];
  if (exact) return exact;
  const m = /^(.*)-(\d{8}|latest)$/.exec(model);
  return m?.[1] ? MODEL_PRICING[m[1]] : undefined;
}
