import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { LineCounter, isMap, isPair, isScalar, parseDocument, type Document } from 'yaml';
import type { PolicyRule, PolicyRuleType } from '../types.js';
import { isRecord } from '../internal/util.js';
import { PolicyFileError } from './errors.js';
import { canonicalJson, sha256Hex } from './hash.js';
import type {
  ActionPattern,
  LoadedPolicy,
  ParamCondition,
  PolicyDocument,
  ToolRule,
} from './types.js';

/** Policy files larger than this are rejected. */
export const MAX_POLICY_FILE_BYTES = 1024 * 1024;
const MAX_PATH_SEGMENTS = 16;
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
const RULE_ID = /^[a-z][a-z0-9_]{0,63}$/;
const DISPOSITIONS = new Set(['block', 'warn', 'require_human_review']);
const OPERATORS = new Set([
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'not_in',
  'matches',
  'exists',
]);
const REQUEST_RULE_TYPES = new Set<PolicyRuleType>([
  'token_budget',
  'cost_budget',
  'pii_detection',
  'prompt_injection',
  'rate_limit',
]);

type Path = (string | number)[];

/**
 * Splits and validates a dot path (`beneficiary.country`). Rejects empty segments and
 * prototype-polluting names. Returns the segments.
 */
export function parseDotPath(path: string): string[] | null {
  if (typeof path !== 'string' || path.length === 0 || path.length > 512) return null;
  const segments = path.split('.');
  if (segments.length > MAX_PATH_SEGMENTS) return null;
  for (const s of segments) {
    if (s.length === 0 || FORBIDDEN_SEGMENTS.has(s)) return null;
  }
  return segments;
}

/** Reads, parses, validates and hashes a policy file. Throws PolicyFileError. */
export async function loadPolicyFile(
  filePath: string,
  opts: { policyVersion?: string } = {},
): Promise<LoadedPolicy> {
  const fileName = basename(String(filePath));
  let bytes: Buffer;
  try {
    bytes = await readFile(filePath);
  } catch (err) {
    const code =
      (err as { code?: string }).code === 'ENOENT' ? 'file_not_found' : 'file_unreadable';
    throw new PolicyFileError({ code, fileName, detail: 'policy file could not be read' });
  }
  return parsePolicySource(bytes, fileName, opts);
}

/** Parses, validates and hashes policy source (YAML 1.2 or JSON). Throws PolicyFileError. */
export function parsePolicySource(
  source: string | Uint8Array,
  fileName: string,
  opts: { policyVersion?: string } = {},
): LoadedPolicy {
  const bytes = typeof source === 'string' ? Buffer.from(source, 'utf8') : Buffer.from(source);
  if (bytes.length > MAX_POLICY_FILE_BYTES) {
    throw new PolicyFileError({
      code: 'file_too_large',
      fileName,
      detail: 'policy file exceeds 1 MiB',
    });
  }
  const text = bytes.toString('utf8');
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, {
    lineCounter,
    prettyErrors: false,
    uniqueKeys: true,
    strict: true,
    version: '1.2',
  });
  const problem = doc.errors[0] ?? doc.warnings[0];
  if (problem) {
    // Never echo the source excerpt: report position and the parser's error code only.
    const pos = lineCounter.linePos(problem.pos[0]);
    throw new PolicyFileError({
      code: 'yaml_syntax',
      fileName,
      detail: `invalid YAML/JSON (${problem.code})`,
      line: pos.line,
      column: pos.col,
    });
  }
  let raw: unknown;
  try {
    raw = doc.toJS({ maxAliasCount: 50 });
  } catch {
    throw new PolicyFileError({
      code: 'yaml_syntax',
      fileName,
      detail: 'invalid YAML/JSON structure',
    });
  }

  const v = new Validator(fileName, doc, lineCounter);
  const document = v.document(raw);
  const versionOverride = opts.policyVersion?.trim();
  if (opts.policyVersion !== undefined && (!versionOverride || versionOverride.length > 128)) {
    throw new PolicyFileError({
      code: 'invalid_policy_version',
      fileName,
      detail: 'policyVersion option must be a non-empty string of at most 128 characters',
    });
  }
  return {
    document,
    fileName,
    policyHash: sha256Hex(bytes),
    canonicalHash: sha256Hex(canonicalJson(document)),
    policyVersion: versionOverride || document.version,
  };
}

class Validator {
  constructor(
    private readonly fileName: string,
    private readonly doc: Document,
    private readonly lines: LineCounter,
  ) {}

  document(raw: unknown): PolicyDocument {
    const root = this.object(raw, [], ['version', 'rules', 'request_rules']);
    const version = root.version;
    if (typeof version !== 'string' && typeof version !== 'number') {
      this.fail(['version'], 'missing_field', 'required string');
    }
    const versionStr = String(version).trim();
    if (!versionStr || versionStr.length > 128) {
      this.fail(['version'], 'invalid_value', 'must be 1-128 characters');
    }

    const rulesRaw = root.rules ?? [];
    if (!Array.isArray(rulesRaw)) this.fail(['rules'], 'invalid_type', 'must be a list');
    const ids = new Set<string>();
    const rules = rulesRaw.map((r, i) => {
      const rule = this.rule(r, ['rules', i]);
      if (ids.has(rule.id)) this.fail(['rules', i, 'id'], 'duplicate_rule_id', 'duplicate rule id');
      ids.add(rule.id);
      return rule;
    });

    let requestRules: PolicyRule[] | undefined;
    if (root.request_rules !== undefined) {
      if (!Array.isArray(root.request_rules)) {
        this.fail(['request_rules'], 'invalid_type', 'must be a list');
      }
      requestRules = root.request_rules.map((r, i) => this.requestRule(r, ['request_rules', i]));
    }
    if (rules.length === 0 && !requestRules?.length) {
      this.fail(['rules'], 'missing_field', 'at least one rule is required');
    }
    return requestRules
      ? { version: versionStr, rules, request_rules: requestRules }
      : { version: versionStr, rules };
  }

  private rule(raw: unknown, path: Path): ToolRule {
    const r = this.object(raw, path, [
      'id',
      'description',
      'action_patterns',
      'disposition',
      'escalate_to',
    ]);
    if (typeof r.id !== 'string' || !RULE_ID.test(r.id)) {
      this.fail([...path, 'id'], 'invalid_rule_id', 'required snake_case id (a-z, 0-9, _; max 64)');
    }
    if (typeof r.description !== 'string' || !r.description.trim()) {
      this.fail([...path, 'description'], 'missing_field', 'required string');
    }
    if (typeof r.disposition !== 'string' || !DISPOSITIONS.has(r.disposition)) {
      this.fail(
        [...path, 'disposition'],
        'invalid_value',
        'must be block, warn or require_human_review',
      );
    }
    if (r.escalate_to !== undefined && r.escalate_to !== 'compliance_webhook') {
      this.fail([...path, 'escalate_to'], 'invalid_value', 'only compliance_webhook is supported');
    }
    const patterns = r.action_patterns;
    if (!Array.isArray(patterns) || patterns.length === 0) {
      this.fail(
        [...path, 'action_patterns'],
        'missing_field',
        'at least one action pattern is required',
      );
    }
    const rule: ToolRule = {
      id: r.id,
      description: r.description,
      action_patterns: patterns.map((p, i) => this.pattern(p, [...path, 'action_patterns', i])),
      disposition: r.disposition as ToolRule['disposition'],
    };
    if (r.escalate_to !== undefined) rule.escalate_to = 'compliance_webhook';
    return rule;
  }

  private pattern(raw: unknown, path: Path): ActionPattern {
    const p = this.object(raw, path, [
      'type',
      'tool',
      'method',
      'method_field',
      'param_conditions',
    ]);
    if (p.type !== 'tool_call') this.fail([...path, 'type'], 'invalid_value', 'must be tool_call');
    if (typeof p.tool !== 'string' || !p.tool) {
      this.fail([...path, 'tool'], 'missing_field', 'required string (tool name or *)');
    }
    const out: ActionPattern = { type: 'tool_call', tool: p.tool };
    if (p.method !== undefined) {
      if (typeof p.method !== 'string' || !p.method) {
        this.fail([...path, 'method'], 'invalid_type', 'must be a non-empty string');
      }
      out.method = p.method;
    }
    if (p.method_field !== undefined) {
      if (typeof p.method_field !== 'string' || !parseDotPath(p.method_field)) {
        this.fail([...path, 'method_field'], 'invalid_path', 'must be a safe dot path');
      }
      if (p.method === undefined) {
        this.fail([...path, 'method_field'], 'invalid_value', 'method_field requires method');
      }
      out.method_field = p.method_field;
    }
    if (p.param_conditions !== undefined) {
      const conds = this.object(p.param_conditions, [...path, 'param_conditions'], null);
      const keys = Object.keys(conds);
      if (keys.length === 0) {
        this.fail([...path, 'param_conditions'], 'invalid_value', 'must not be empty');
      }
      out.param_conditions = {};
      for (const key of keys) {
        if (!parseDotPath(key)) {
          this.fail(
            [...path, 'param_conditions', key],
            'invalid_path',
            'parameter key must be a safe dot path',
            true,
          );
        }
        Object.defineProperty(out.param_conditions, key, {
          value: this.condition(conds[key], [...path, 'param_conditions', key]),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }
    return out;
  }

  private condition(raw: unknown, path: Path): ParamCondition {
    const c = this.object(raw, path, null);
    const ops = Object.keys(c);
    if (ops.length === 0) this.fail(path, 'invalid_value', 'at least one operator is required');
    const out: ParamCondition = {};
    for (const op of ops) {
      const value = c[op];
      const at = [...path, op];
      if (!OPERATORS.has(op)) this.fail(at, 'unknown_operator', `unknown operator "${op}"`, true);
      switch (op) {
        case 'eq':
        case 'ne':
          if (!isScalar_(value))
            this.fail(at, 'invalid_type', 'must be a string, number or boolean');
          out[op] = value;
          break;
        case 'gt':
        case 'gte':
        case 'lt':
        case 'lte':
          if (typeof value !== 'number' || !Number.isFinite(value)) {
            this.fail(at, 'invalid_type', 'must be a finite number');
          }
          out[op] = value;
          break;
        case 'in':
        case 'not_in':
          if (!Array.isArray(value) || value.length === 0 || !value.every(isScalar_)) {
            this.fail(
              at,
              'invalid_type',
              'must be a non-empty list of strings, numbers or booleans',
            );
          }
          out[op] = value;
          break;
        case 'matches':
          if (typeof value !== 'string' || value.length > 1000) {
            this.fail(at, 'invalid_type', 'must be a regular expression string (max 1000 chars)');
          }
          try {
            new RegExp(value);
          } catch {
            this.fail(at, 'invalid_regex', 'invalid regular expression');
          }
          out.matches = value;
          break;
        case 'exists':
          if (typeof value !== 'boolean') this.fail(at, 'invalid_type', 'must be true or false');
          out.exists = value;
          break;
      }
    }
    return out;
  }

  private requestRule(raw: unknown, path: Path): PolicyRule {
    const r = this.object(raw, path, ['type', 'name', 'params']);
    if (typeof r.type !== 'string' || !REQUEST_RULE_TYPES.has(r.type as PolicyRuleType)) {
      this.fail(
        [...path, 'type'],
        'invalid_value',
        `must be one of ${[...REQUEST_RULE_TYPES].join(', ')}`,
      );
    }
    if (r.name !== undefined && typeof r.name !== 'string') {
      this.fail([...path, 'name'], 'invalid_type', 'must be a string');
    }
    if (!isRecord(r.params)) this.fail([...path, 'params'], 'invalid_type', 'must be a mapping');
    const rule = { type: r.type, params: r.params } as PolicyRule;
    if (typeof r.name === 'string') rule.name = r.name;
    return rule;
  }

  /** Asserts a mapping; with `allowed`, rejects unknown keys. */
  private object(raw: unknown, path: Path, allowed: string[] | null): Record<string, unknown> {
    if (!isRecord(raw)) this.fail(path, 'invalid_type', 'must be a mapping');
    if (allowed) {
      for (const key of Object.keys(raw)) {
        if (!allowed.includes(key))
          this.fail([...path, key], 'unknown_field', `unknown field "${key}"`, true);
      }
    }
    return raw;
  }

  private fail(path: Path, code: string, detail: string, atKey = false): never {
    const pos = this.position(path, atKey);
    throw new PolicyFileError({
      code,
      fileName: this.fileName,
      detail,
      field: formatPath(path),
      line: pos?.line ?? null,
      column: pos?.col ?? null,
    });
  }

  private position(path: Path, atKey: boolean): { line: number; col: number } | null {
    try {
      let node: unknown = this.doc.contents;
      if (atKey && path.length > 0) {
        const parent =
          path.length > 1 ? this.doc.getIn(path.slice(0, -1), true) : this.doc.contents;
        const last = path[path.length - 1];
        if (isMap(parent)) {
          const pair = parent.items.find(
            (it) => isPair(it) && isScalar(it.key) && it.key.value === last,
          );
          node = pair && isPair(pair) ? pair.key : parent;
        } else node = parent;
      } else if (path.length > 0) {
        node = this.doc.getIn(path, true) ?? this.doc.getIn(path.slice(0, -1), true);
      }
      const range = (node as { range?: [number, number, number] } | null)?.range;
      return range ? this.lines.linePos(range[0]) : null;
    } catch {
      return null;
    }
  }
}

function isScalar_(v: unknown): v is string | number | boolean {
  return (
    typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))
  );
}

function formatPath(path: Path): string {
  return path.reduce<string>(
    (acc, p) => (typeof p === 'number' ? `${acc}[${p}]` : acc ? `${acc}.${p}` : p),
    '',
  );
}
