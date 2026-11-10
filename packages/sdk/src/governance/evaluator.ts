import { isRecord } from '../internal/util.js';
import { parseDotPath } from './schema.js';
import type {
  ActionPattern,
  ParamCondition,
  ToolDisposition,
  ToolEvaluation,
  ToolRule,
} from './types.js';

type Match = 'match' | 'no_match' | 'unevaluable';

const RANK: Record<ToolDisposition, number> = {
  pass: 0,
  warn: 1,
  escalated: 2,
  error_blocked: 3,
  block: 4,
};

const MISSING = Symbol('missing');

/**
 * Reads a dot path from plain objects only. Own properties only (no prototype chain),
 * no arrays, no prototype-polluting segments. Returns MISSING when absent.
 */
export function readPath(input: unknown, path: string): unknown {
  const segments = parseDotPath(path);
  if (!segments) return MISSING;
  let cur: unknown = input;
  for (const seg of segments) {
    if (!isRecord(cur) || !Object.prototype.hasOwnProperty.call(cur, seg)) return MISSING;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/**
 * Compiled, deterministic tool-call evaluator.
 *
 * Semantics (fail-closed, decision A8):
 * - Patterns in a rule are ORed; `param_conditions` keys and operators are ANDed.
 * - A constrained parameter that is missing or has the wrong type makes the pattern
 *   "unevaluable". So does a missing/non-string method field when the pattern names a method.
 * - A definite "no match" on any condition means the pattern does not apply.
 * - An unevaluable rule yields `error_blocked`, whatever its disposition: QuotaGate never
 *   silently passes an action it could not check.
 * - The strictest outcome wins: block > error_blocked > escalated > warn > pass.
 */
export class ToolPolicyEvaluator {
  private readonly regexCache = new Map<string, RegExp>();
  /** Method names declared anywhere in the policy; only these are reported on events. */
  private readonly knownMethods = new Map<string, Set<string>>();

  constructor(private readonly rules: readonly ToolRule[]) {
    for (const rule of rules) {
      for (const p of rule.action_patterns) {
        if (p.method === undefined) continue;
        const field = p.method_field ?? 'method';
        let set = this.knownMethods.get(field);
        if (!set) this.knownMethods.set(field, (set = new Set()));
        set.add(p.method);
      }
    }
  }

  evaluate(toolName: string, input: unknown): ToolEvaluation {
    const started = performance.now();
    let best: {
      disposition: ToolDisposition;
      rule: ToolRule | null;
      reason: ToolEvaluation['reasonCode'];
    } = {
      disposition: 'pass',
      rule: null,
      reason: 'no_rule_matched',
    };
    const matched: string[] = [];
    try {
      for (const rule of this.rules) {
        const m = this.matchRule(rule, toolName, input);
        if (m === 'no_match') continue;
        matched.push(rule.id);
        const disposition: ToolDisposition =
          m === 'unevaluable'
            ? 'error_blocked'
            : rule.disposition === 'require_human_review'
              ? 'escalated'
              : rule.disposition;
        if (RANK[disposition] > RANK[best.disposition]) {
          best = {
            disposition,
            rule,
            reason: m === 'unevaluable' ? 'condition_not_evaluable' : 'rule_matched',
          };
        }
      }
    } catch {
      return {
        disposition: 'error_blocked',
        ruleId: null,
        matchedRuleIds: matched,
        reasonCode: 'evaluator_error',
        toolMethod: null,
        escalateTo: null,
        latencyMs: elapsed(started),
      };
    }
    return {
      disposition: best.disposition,
      ruleId: best.rule?.id ?? null,
      matchedRuleIds: matched,
      reasonCode: best.reason,
      toolMethod: this.declaredMethod(input),
      escalateTo: best.rule?.escalate_to ?? null,
      latencyMs: elapsed(started),
    };
  }

  /** The input's method, only if it equals a method name the policy declares. */
  declaredMethod(input: unknown): string | null {
    for (const [field, names] of this.knownMethods) {
      const v = readPath(input, field);
      if (typeof v === 'string' && names.has(v)) return v;
    }
    return null;
  }

  private matchRule(rule: ToolRule, toolName: string, input: unknown): Match {
    let unevaluable = false;
    for (const pattern of rule.action_patterns) {
      const m = this.matchPattern(pattern, toolName, input);
      if (m === 'match') return 'match';
      if (m === 'unevaluable') unevaluable = true;
    }
    return unevaluable ? 'unevaluable' : 'no_match';
  }

  private matchPattern(p: ActionPattern, toolName: string, input: unknown): Match {
    if (p.tool !== '*' && p.tool !== toolName) return 'no_match';
    const results: Match[] = [];
    if (p.method !== undefined) {
      const v = readPath(input, p.method_field ?? 'method');
      if (typeof v !== 'string') results.push('unevaluable');
      else if (v !== p.method) return 'no_match';
    }
    for (const [key, cond] of Object.entries(p.param_conditions ?? {})) {
      const r = this.matchCondition(readPath(input, key), cond);
      if (r === 'no_match') return 'no_match';
      results.push(r);
    }
    return results.includes('unevaluable') ? 'unevaluable' : 'match';
  }

  private matchCondition(value: unknown, c: ParamCondition): Match {
    const missing = value === MISSING;
    let unevaluable = false;
    const check = (ok: boolean | null): boolean => {
      if (ok === null) {
        unevaluable = true;
        return true;
      }
      return ok;
    };
    if (c.exists !== undefined && !missing !== c.exists) return 'no_match';
    if (c.eq !== undefined && !check(sameType(value, c.eq) ? value === c.eq : null))
      return 'no_match';
    if (c.ne !== undefined && !check(sameType(value, c.ne) ? value !== c.ne : null))
      return 'no_match';
    const n = typeof value === 'number' && Number.isFinite(value) ? value : null;
    if (c.gt !== undefined && !check(n === null ? null : n > c.gt)) return 'no_match';
    if (c.gte !== undefined && !check(n === null ? null : n >= c.gte)) return 'no_match';
    if (c.lt !== undefined && !check(n === null ? null : n < c.lt)) return 'no_match';
    if (c.lte !== undefined && !check(n === null ? null : n <= c.lte)) return 'no_match';
    if (c.in !== undefined && !check(scalarIn(value, c.in))) return 'no_match';
    if (c.not_in !== undefined) {
      const r = scalarIn(value, c.not_in);
      if (!check(r === null ? null : !r)) return 'no_match';
    }
    if (c.matches !== undefined) {
      const ok = typeof value === 'string' ? this.regex(c.matches).test(value) : null;
      if (!check(ok)) return 'no_match';
    }
    return unevaluable ? 'unevaluable' : 'match';
  }

  private regex(source: string): RegExp {
    let re = this.regexCache.get(source);
    if (!re) this.regexCache.set(source, (re = new RegExp(source)));
    return re;
  }
}

function sameType(value: unknown, operand: string | number | boolean): boolean {
  if (typeof operand === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === typeof operand;
}

/** null when the value is missing or not a scalar of a type present in the list. */
function scalarIn(value: unknown, list: (string | number | boolean)[]): boolean | null {
  if (!list.some((x) => sameType(value, x))) return null;
  return list.includes(value as string | number | boolean);
}

function elapsed(started: number): number {
  return Math.max(0, Math.round(performance.now() - started));
}
