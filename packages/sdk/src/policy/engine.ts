import type {
  CustomPattern,
  Policy,
  PolicyAction,
  PolicyCheck,
  PolicyEvaluationContext,
  PolicyRule,
  PolicyRuleType,
} from '../types.js';
import { errorMessage, isRecord, stderrLogger, type Logger } from '../internal/util.js';
import { PolicyViolationError } from './errors.js';
import {
  BUILT_IN_PII_PATTERNS,
  PII_PATTERNS,
  PROMPT_INJECTION_GROUPS,
  PROMPT_INJECTION_GROUP_NAMES,
} from './patterns.js';
import { lookupModelPrice } from './pricing.js';
import { estimateInputTokens, messageSegments } from './text.js';

export interface PolicyEngineOptions {
  /** What to do when a rule fails unexpectedly (bad config, invalid regex). Default 'log'. */
  onPolicyError?: 'log' | 'block';
  logger?: Logger;
  /** Clock override for tests. */
  now?: () => number;
}

interface RuleOutcome {
  triggered: boolean;
  reason: string | null;
  /** Side effect to apply only if the call is allowed (rate-limit bookkeeping). */
  commit?: () => void;
}

type Params = Record<string, unknown>;

/**
 * Pre-flight policy evaluation. Runs synchronously before the Anthropic call.
 * Rules run in order; the first rule that triggers with action 'block' throws
 * PolicyViolationError; 'warn' results are recorded and evaluation continues.
 */
export class PolicyEngine {
  private readonly policies: Policy[];
  private readonly onPolicyError: 'log' | 'block';
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly rateWindows = new Map<string, number[]>();
  private readonly regexCache = new Map<string, RegExp>();

  constructor(policies: Policy[] = [], opts: PolicyEngineOptions = {}) {
    this.policies = [...policies];
    this.onPolicyError = opts.onPolicyError ?? 'log';
    this.logger = opts.logger ?? stderrLogger;
    this.now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.policies.length;
  }

  /** Returns a PolicyCheck for every evaluated rule, or throws PolicyViolationError. */
  evaluate(params: Params, context: PolicyEvaluationContext = {}): PolicyCheck[] {
    const checks: PolicyCheck[] = [];
    const commits: (() => void)[] = [];

    for (const policy of this.policies) {
      if (!isRecord(policy) || policy.enabled === false || !appliesTo(policy, context)) continue;
      const rules = Array.isArray(policy.rules) ? policy.rules : [];

      rules.forEach((rule, index) => {
        const ruleType = (isRecord(rule) ? rule.type : 'unknown') as PolicyRuleType;
        const ruleName = (isRecord(rule) && typeof rule.name === 'string' && rule.name) || ruleType;
        const evaluatedAt = new Date(this.now());

        let outcome: RuleOutcome;
        try {
          outcome = this.evaluateRule(rule, params, `${policy.policyId}#${index}`);
        } catch (err) {
          const reason = `rule evaluation failed: ${errorMessage(err)}`;
          if (this.onPolicyError === 'block') {
            const check: PolicyCheck = {
              policyId: policy.policyId,
              ruleName,
              ruleType,
              result: 'block',
              reason,
              evaluatedAt,
            };
            checks.push(check);
            throw new PolicyViolationError({
              policyId: policy.policyId,
              ruleName,
              ruleType,
              reason,
              policyChecks: checks,
            });
          }
          this.log(`policy "${policy.policyId}" ${reason}; allowing call (onPolicyError: 'log')`);
          checks.push({
            policyId: policy.policyId,
            ruleName,
            ruleType,
            result: 'pass',
            reason,
            evaluatedAt,
          });
          return;
        }

        if (!outcome.triggered) {
          checks.push({
            policyId: policy.policyId,
            ruleName,
            ruleType,
            result: 'pass',
            reason: outcome.reason,
            evaluatedAt,
          });
          if (outcome.commit) commits.push(outcome.commit);
          return;
        }

        const action = resolveAction(rule, policy);
        const reason = outcome.reason ?? `${ruleType} triggered`;
        checks.push({
          policyId: policy.policyId,
          ruleName,
          ruleType,
          result: action,
          reason,
          evaluatedAt,
        });
        if (action === 'block') {
          throw new PolicyViolationError({
            policyId: policy.policyId,
            ruleName,
            ruleType,
            reason,
            policyChecks: checks,
          });
        }
        if (outcome.commit) commits.push(outcome.commit);
      });
    }

    // The call is allowed: record it against rate-limit windows.
    for (const commit of commits) commit();
    return checks;
  }

  private evaluateRule(rule: PolicyRule, params: Params, key: string): RuleOutcome {
    if (!isRecord(rule)) throw new Error('rule must be an object');
    const p: Params = isRecord(rule.params) ? (rule.params as Params) : {};
    switch (rule.type) {
      case 'token_budget':
        return this.tokenBudget(p, params);
      case 'cost_budget':
        return this.costBudget(p, params);
      case 'pii_detection':
        return this.piiDetection(p, params);
      case 'rate_limit':
        return this.rateLimit(p, key);
      case 'prompt_injection':
        return this.promptInjection(p, params);
      default:
        throw new Error(`unknown rule type "${String((rule as { type?: unknown }).type)}"`);
    }
  }

  private tokenBudget(p: Params, params: Params): RuleOutcome {
    const maxOut = num(p.maxOutputTokens);
    const maxIn = num(p.maxInputTokens);
    if (maxOut === undefined && maxIn === undefined) {
      throw new Error('token_budget requires maxOutputTokens and/or maxInputTokens');
    }
    const maxTokens = num(params.max_tokens);
    if (maxOut !== undefined && maxTokens !== undefined && maxTokens > maxOut) {
      return {
        triggered: true,
        reason: `max_tokens ${maxTokens} exceeds maxOutputTokens ${maxOut}`,
      };
    }
    if (maxIn !== undefined) {
      const est = estimateInputTokens(params);
      if (est > maxIn) {
        return {
          triggered: true,
          reason: `estimated input tokens ~${est} exceed maxInputTokens ${maxIn}`,
        };
      }
    }
    return { triggered: false, reason: null };
  }

  private costBudget(p: Params, params: Params): RuleOutcome {
    const limit = num(p.maxUsdPerSpan);
    if (limit === undefined) throw new Error('cost_budget requires maxUsdPerSpan');
    const model = typeof params.model === 'string' ? params.model : '';
    const inputTokens = estimateInputTokens(params);
    const outputTokens = num(params.max_tokens) ?? 0;

    let inPrice: number;
    let outPrice: number;
    const override = isRecord(p.pricing) ? p.pricing : undefined;
    if (override && num(override.inputPerMTok) !== undefined) {
      inPrice = num(override.inputPerMTok) ?? 0;
      outPrice = num(override.outputPerMTok) ?? 0;
    } else {
      const price = lookupModelPrice(model);
      if (!price) {
        // Never guess a price (DECISIONS D7): skip rather than block on unknown models.
        return {
          triggered: false,
          reason: `skipped: no list price for model "${model}"; set params.pricing to enforce`,
        };
      }
      const long = price.longContext;
      const useLong = long !== undefined && inputTokens > long.aboveInputTokens;
      inPrice = useLong ? long.inputPerMTok : price.inputPerMTok;
      outPrice = useLong ? long.outputPerMTok : price.outputPerMTok;
    }

    const estimate = (inputTokens / 1e6) * inPrice + (outputTokens / 1e6) * outPrice;
    if (estimate > limit) {
      return {
        triggered: true,
        reason: `estimated worst-case cost $${estimate.toFixed(4)} (~${inputTokens} input + ${outputTokens} max output tokens, ${model}) exceeds maxUsdPerSpan $${limit}`,
      };
    }
    return { triggered: false, reason: null };
  }

  private piiDetection(p: Params, params: Params): RuleOutcome {
    const names = Array.isArray(p.patterns) ? (p.patterns as string[]) : BUILT_IN_PII_PATTERNS;
    const text = messageSegments(params.messages)
      .map((s) => s.text)
      .join('\n');
    if (!text) return { triggered: false, reason: null };

    const hits: string[] = [];
    for (const name of names) {
      const pattern = PII_PATTERNS[name as keyof typeof PII_PATTERNS];
      if (!pattern) throw new Error(`unknown pii pattern "${name}"`);
      const count = countMatches(pattern.regex, text, pattern.validate);
      if (count > 0) hits.push(`${name} (${count})`);
    }
    for (const custom of customPatterns(p.customPatterns)) {
      const count = countMatches(this.compile(custom, 'g'), text);
      if (count > 0) hits.push(`${custom.name} (${count})`);
    }
    return hits.length
      ? { triggered: true, reason: `PII detected: ${hits.join(', ')}` }
      : { triggered: false, reason: null };
  }

  private rateLimit(p: Params, key: string): RuleOutcome {
    const maxCalls = num(p.maxCalls);
    const windowSeconds = num(p.windowSeconds);
    if (maxCalls === undefined || windowSeconds === undefined || windowSeconds <= 0) {
      throw new Error('rate_limit requires maxCalls and windowSeconds > 0');
    }
    const now = this.now();
    const windowStart = now - windowSeconds * 1000;
    const calls = (this.rateWindows.get(key) ?? []).filter((t) => t > windowStart);
    this.rateWindows.set(key, calls);
    const commit = () => {
      calls.push(now);
      // Keep memory bounded to what the rule can ever need.
      if (calls.length > maxCalls + 1) calls.splice(0, calls.length - (maxCalls + 1));
    };
    if (calls.length >= maxCalls) {
      return {
        triggered: true,
        reason: `rate limit exceeded: ${calls.length} calls in the last ${windowSeconds}s (max ${maxCalls})`,
        commit,
      };
    }
    return { triggered: false, reason: null, commit };
  }

  private promptInjection(p: Params, params: Params): RuleOutcome {
    const disabled = new Set(Array.isArray(p.disabledGroups) ? (p.disabledGroups as string[]) : []);
    // Scan user turns and tool_result blocks only (untrusted input), not assistant turns.
    const segments = messageSegments(params.messages).filter((s) => s.source !== 'assistant');
    if (!segments.length) return { triggered: false, reason: null };

    const hits = new Set<string>();
    for (const group of PROMPT_INJECTION_GROUP_NAMES) {
      if (disabled.has(group)) continue;
      for (const seg of segments) {
        const found = PROMPT_INJECTION_GROUPS[group].some(({ regex, validate }) => {
          const m = regex.exec(seg.text);
          return m !== null && (!validate || validate(m[0]));
        });
        if (found) {
          hits.add(`${group} in ${seg.source === 'tool_result' ? 'tool_result' : 'user message'}`);
          break;
        }
      }
    }
    for (const custom of customPatterns(p.customPatterns)) {
      const re = this.compile(custom, '');
      const seg = segments.find((s) => re.test(s.text));
      if (seg)
        hits.add(
          `${custom.name} in ${seg.source === 'tool_result' ? 'tool_result' : 'user message'}`,
        );
    }
    return hits.size
      ? { triggered: true, reason: `possible prompt injection: ${[...hits].join(', ')}` }
      : { triggered: false, reason: null };
  }

  private compile(custom: CustomPattern, extraFlags: string): RegExp {
    const flags = [...new Set((custom.flags ?? '').replace(/[gy]/g, '') + extraFlags)].join('');
    const cacheKey = `${flags}/${custom.pattern}`;
    let re = this.regexCache.get(cacheKey);
    if (!re) {
      re = new RegExp(custom.pattern, flags); // throws on invalid pattern -> onPolicyError
      this.regexCache.set(cacheKey, re);
    }
    re.lastIndex = 0;
    return re;
  }

  private log(msg: string): void {
    try {
      this.logger(msg);
    } catch {
      // never throw from logging
    }
  }
}

function appliesTo(policy: Policy, ctx: PolicyEvaluationContext): boolean {
  if (policy.scope === 'project' || policy.scopeValue == null) return true;
  if (policy.scope === 'agent') return ctx.agentId === policy.scopeValue;
  if (policy.scope === 'task') return ctx.taskLabel === policy.scopeValue;
  return false;
}

/**
 * Action precedence: rule.params.action, then the policy action, then the rule default.
 * prompt_injection is the exception: regex heuristics have false positives, so it only
 * blocks when the rule itself opts in (`params.action: 'block'`) (DECISIONS D4).
 */
function resolveAction(rule: PolicyRule, policy: Policy): PolicyAction {
  const own = isRecord(rule.params) ? rule.params.action : undefined;
  if (own === 'block' || own === 'warn') return own;
  if (rule.type === 'prompt_injection') return 'warn';
  if (policy.action === 'block' || policy.action === 'warn') return policy.action;
  return rule.type === 'pii_detection' ? 'warn' : 'block';
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function customPatterns(v: unknown): CustomPattern[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new Error('customPatterns must be an array');
  return v.map((c) => {
    if (!isRecord(c) || typeof c.pattern !== 'string' || typeof c.name !== 'string') {
      throw new Error('custom patterns need string "name" and "pattern"');
    }
    return c as unknown as CustomPattern;
  });
}

function countMatches(regex: RegExp, text: string, validate?: (m: string) => boolean): number {
  const re = regex.global ? regex : new RegExp(regex.source, regex.flags + 'g');
  re.lastIndex = 0;
  let count = 0;
  for (const m of text.matchAll(re)) {
    if (!validate || validate(m[0])) count++;
  }
  return count;
}
