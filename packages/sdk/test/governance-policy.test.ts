import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PolicyFileError } from '../src/governance/errors.js';
import { ToolPolicyEvaluator, readPath } from '../src/governance/evaluator.js';
import { loadPolicyFile, parseDotPath, parsePolicySource } from '../src/governance/schema.js';

const examples = fileURLToPath(new URL('../examples/policies/', import.meta.url));
const FINTECH = `${examples}fintech.yaml`;
const LEGALTECH = `${examples}legaltech.yaml`;

function expectFileError(fn: () => unknown, code: string): PolicyFileError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(PolicyFileError);
    expect((err as PolicyFileError).code).toBe(code);
    return err as PolicyFileError;
  }
  throw new Error(`expected PolicyFileError ${code}`);
}

const minimal = (rules: string) => `version: "1.0.0"\nrules:\n${rules}`;

describe('policy loader', () => {
  it('loads the FinTech example, hashing the raw file bytes', async () => {
    const policy = await loadPolicyFile(FINTECH);
    const raw = readFileSync(FINTECH);
    expect(policy.policyHash).toBe(createHash('sha256').update(raw).digest('hex'));
    expect(policy.policyVersion).toBe('1.2.0');
    expect(policy.fileName).toBe('fintech.yaml');
    expect(policy.document.rules.map((r) => r.id)).toContain('no_account_closure');
    expect(policy.document.request_rules?.[0]?.type).toBe('pii_detection');
  });

  it('loads the LegalTech example', async () => {
    const policy = await loadPolicyFile(LEGALTECH);
    expect(policy.policyVersion).toBe('0.3.1');
    expect(
      policy.document.rules.every((r) => r.action_patterns[0]?.tool === 'document_signing'),
    ).toBe(true);
  });

  it('raw hash changes with whitespace; canonical hash does not', () => {
    const a = parsePolicySource(
      minimal(
        '  - id: r\n    description: d\n    action_patterns: [{type: tool_call, tool: t}]\n    disposition: block\n',
      ),
      'a.yaml',
    );
    const b = parsePolicySource(
      minimal(
        '  - id: r\n    description:   d\n    action_patterns:\n      - {type: tool_call, tool: t}\n    disposition: block\n\n',
      ),
      'b.yaml',
    );
    expect(a.policyHash).not.toBe(b.policyHash);
    expect(a.canonicalHash).toBe(b.canonicalHash);
  });

  it('accepts JSON and a policyVersion override', () => {
    const json = JSON.stringify({
      version: '2.0.0',
      rules: [
        {
          id: 'r1',
          description: 'd',
          action_patterns: [{ type: 'tool_call', tool: '*' }],
          disposition: 'warn',
        },
      ],
    });
    const p = parsePolicySource(json, 'p.json', { policyVersion: 'abc1234' });
    expect(p.policyVersion).toBe('abc1234');
    expect(p.document.version).toBe('2.0.0');
  });

  it('reports a missing file without throwing a raw fs error', async () => {
    await expect(loadPolicyFile('/nonexistent/dir/prod.yaml')).rejects.toMatchObject({
      name: 'PolicyFileError',
      code: 'file_not_found',
      fileName: 'prod.yaml',
    });
  });

  it('rejects unknown fields with file, line and field', () => {
    const err = expectFileError(
      () => parsePolicySource('version: "1"\nrules: []\nextra: true\n', 'prod.yaml'),
      'unknown_field',
    );
    expect(err.line).toBe(3);
    expect(err.field).toBe('extra');
    expect(err.message).toMatch(/^prod\.yaml:3:1: extra:/);
  });

  it('rejects duplicate rule ids, unknown operators, invalid regex and bad dispositions', () => {
    const rule = (id: string, extra = '', disposition = 'block') =>
      `  - id: ${id}\n    description: d\n    action_patterns:\n      - type: tool_call\n        tool: t\n${extra}    disposition: ${disposition}\n`;
    expectFileError(
      () => parsePolicySource(minimal(rule('a') + rule('a')), 'p.yaml'),
      'duplicate_rule_id',
    );
    expectFileError(
      () =>
        parsePolicySource(
          minimal(
            rule('a', '        param_conditions:\n          amount:\n            above: 5\n'),
          ),
          'p.yaml',
        ),
      'unknown_operator',
    );
    expectFileError(
      () =>
        parsePolicySource(
          minimal(
            rule('a', '        param_conditions:\n          name:\n            matches: "("\n'),
          ),
          'p.yaml',
        ),
      'invalid_regex',
    );
    expectFileError(
      () => parsePolicySource(minimal(rule('a', '', 'allow')), 'p.yaml'),
      'invalid_value',
    );
    expectFileError(() => parsePolicySource(minimal(rule('Bad-Id')), 'p.yaml'), 'invalid_rule_id');
    expectFileError(
      () =>
        parsePolicySource(
          minimal(
            rule('a', '        param_conditions:\n          amount:\n            gt: "5000"\n'),
          ),
          'p.yaml',
        ),
      'invalid_type',
    );
    expectFileError(
      () => parsePolicySource(minimal(rule('a', '        method_field: op\n')), 'p.yaml'),
      'invalid_value',
    );
  });

  it('rejects missing version, empty rule sets and unsafe parameter paths', () => {
    expectFileError(() => parsePolicySource('rules: []\n', 'p.yaml'), 'missing_field');
    expectFileError(
      () => parsePolicySource('version: "1"\nrules: []\n', 'p.yaml'),
      'missing_field',
    );
    for (const key of ['__proto__', 'a.constructor', 'a..b', 'prototype']) {
      expectFileError(
        () =>
          parsePolicySource(
            minimal(
              `  - id: a\n    description: d\n    action_patterns:\n      - type: tool_call\n        tool: t\n        param_conditions:\n          "${key}":\n            exists: true\n    disposition: block\n`,
            ),
            'p.yaml',
          ),
        'invalid_path',
      );
    }
  });

  it('YAML syntax errors report position only and never echo file contents', () => {
    const secret = 'ACCT-SECRET-998877';
    const err = expectFileError(
      () =>
        parsePolicySource(
          `version: "1"\nrules:\n  - id: a\n    description: ${secret}\n  bad: [\n`,
          'p.yaml',
        ),
      'yaml_syntax',
    );
    expect(err.message).not.toContain(secret);
    expect(err.line).toBeGreaterThan(0);
  });

  it('rejects duplicate YAML keys and oversized files', () => {
    expectFileError(
      () => parsePolicySource('version: "1"\nversion: "2"\nrules: []\n', 'p.yaml'),
      'yaml_syntax',
    );
    expectFileError(
      () => parsePolicySource('#'.repeat(1024 * 1024 + 1), 'p.yaml'),
      'file_too_large',
    );
  });

  it('validates request_rules types', () => {
    expectFileError(
      () =>
        parsePolicySource(
          'version: "1"\nrequest_rules:\n  - type: magic\n    params: {}\n',
          'p.yaml',
        ),
      'invalid_value',
    );
    const p = parsePolicySource(
      'version: "1"\nrequest_rules:\n  - type: rate_limit\n    params: {maxCalls: 1, windowSeconds: 60}\n',
      'p.yaml',
    );
    expect(p.document.rules).toEqual([]);
  });
});

describe('dot paths', () => {
  it('parses safe paths and rejects unsafe ones', () => {
    expect(parseDotPath('beneficiary.country')).toEqual(['beneficiary', 'country']);
    expect(parseDotPath('')).toBeNull();
    expect(parseDotPath('a.__proto__')).toBeNull();
    expect(parseDotPath(Array(20).fill('a').join('.'))).toBeNull();
  });

  it('reads own properties of plain objects only', () => {
    const inherited = Object.create({ method: 'close_account' }) as Record<string, unknown>;
    expect(typeof readPath(inherited, 'method')).toBe('symbol');
    expect(typeof readPath({ a: [{ b: 1 }] }, 'a.0.b')).toBe('symbol');
    expect(typeof readPath(null, 'a')).toBe('symbol');
    expect(typeof readPath({ toString: 1 }, 'constructor')).toBe('symbol');
    expect(readPath({ a: { b: 2 } }, 'a.b')).toBe(2);
  });
});

describe('tool policy evaluator (FinTech example)', async () => {
  const policy = await loadPolicyFile(FINTECH);
  const ev = new ToolPolicyEvaluator(policy.document.rules);
  const transfer = (input: unknown) => ev.evaluate('payments', input);

  it('blocks a prohibited method and passes other methods', () => {
    const r = ev.evaluate('account_management', { method: 'close_account', account_id: 'A99321' });
    expect(r).toMatchObject({
      disposition: 'block',
      ruleId: 'no_account_closure',
      toolMethod: 'close_account',
      escalateTo: 'compliance_webhook',
    });
    expect(ev.evaluate('account_management', { method: 'get_balance' })).toMatchObject({
      disposition: 'pass',
      ruleId: null,
      toolMethod: null,
    });
    expect(ev.evaluate('crm', { method: 'close_account' }).disposition).toBe('pass');
  });

  it('escalates over-limit transfers and passes small ones', () => {
    const big = transfer({
      method: 'initiate_transfer',
      amount: 6000,
      beneficiary: { country: 'US' },
    });
    expect(big).toMatchObject({ disposition: 'escalated', ruleId: 'transfer_limit' });
    expect(
      transfer({ method: 'initiate_transfer', amount: 4000, beneficiary: { country: 'US' } })
        .disposition,
    ).toBe('pass');
    expect(
      transfer({ method: 'initiate_transfer', amount: 5000, beneficiary: { country: 'US' } })
        .disposition,
    ).toBe('pass');
  });

  it('treats missing or wrong-type constrained parameters as unevaluable and denies', () => {
    for (const input of [
      { method: 'initiate_transfer', amount: '6000', beneficiary: { country: 'US' } },
      { method: 'initiate_transfer', beneficiary: { country: 'US' } },
      { method: 'initiate_transfer', amount: Number.NaN, beneficiary: { country: 'US' } },
      { method: 'initiate_transfer', amount: null, beneficiary: { country: 'US' } },
      { method: 'initiate_transfer', amount: 100 }, // beneficiary.country missing
      { method: 'initiate_transfer', amount: 100, beneficiary: 'IR' },
      { method: 'initiate_transfer', amount: 100, beneficiary: { country: 7 } },
    ]) {
      const r = transfer(input);
      expect(r.disposition, JSON.stringify(input)).toBe('error_blocked');
      expect(r.reasonCode).toBe('condition_not_evaluable');
    }
  });

  it('denies when the method field is missing, non-string, or the input is malformed', () => {
    for (const input of [
      {},
      { method: 42 },
      null,
      undefined,
      'close_account',
      ['close_account'],
      Object.create({ method: 'close_account' }),
    ]) {
      expect(ev.evaluate('account_management', input).disposition).toBe('error_blocked');
    }
  });

  it('nested in-list blocks win over review (strictest disposition)', () => {
    const r = transfer({
      method: 'initiate_transfer',
      amount: 9000,
      beneficiary: { country: 'IR' },
    });
    expect(r.disposition).toBe('block');
    expect(r.ruleId).toBe('sanctioned_destination');
    expect(r.matchedRuleIds).toEqual(['transfer_limit', 'sanctioned_destination']);
  });

  it('a definite non-match on one condition makes the pattern not apply', () => {
    // amount is definitely <= 5000, so transfer_limit cannot fire; country is fine.
    expect(
      transfer({ method: 'initiate_transfer', amount: 10, beneficiary: { country: 'US' } })
        .disposition,
    ).toBe('pass');
  });

  it('warns on flagged methods', () => {
    expect(ev.evaluate('account_management', { method: 'freeze_account' })).toMatchObject({
      disposition: 'warn',
      ruleId: 'account_freeze_notice',
    });
  });
});

describe('tool policy evaluator operators', () => {
  const ev = (cond: string, tool = 't') =>
    new ToolPolicyEvaluator(
      parsePolicySource(
        minimal(
          `  - id: r\n    description: d\n    action_patterns:\n      - type: tool_call\n        tool: ${tool}\n        param_conditions:\n${cond}    disposition: block\n`,
        ),
        'p.yaml',
      ).document.rules,
    );

  it('eq / ne compare same-typed scalars and deny on type mismatch', () => {
    const e = ev('          status:\n            eq: completed\n');
    expect(e.evaluate('t', { status: 'completed' }).disposition).toBe('block');
    expect(e.evaluate('t', { status: 'draft' }).disposition).toBe('pass');
    expect(e.evaluate('t', { status: 1 }).disposition).toBe('error_blocked');
    const b = ev('          dry_run:\n            ne: true\n');
    expect(b.evaluate('t', { dry_run: false }).disposition).toBe('block');
    expect(b.evaluate('t', { dry_run: true }).disposition).toBe('pass');
    expect(b.evaluate('t', { dry_run: 'false' }).disposition).toBe('error_blocked');
  });

  it('gte / lte bounds and not_in', () => {
    const e = ev('          n:\n            gte: 10\n            lte: 20\n');
    expect(e.evaluate('t', { n: 10 }).disposition).toBe('block');
    expect(e.evaluate('t', { n: 21 }).disposition).toBe('pass');
    const n = ev('          region:\n            not_in: [us, eu]\n');
    expect(n.evaluate('t', { region: 'apac' }).disposition).toBe('block');
    expect(n.evaluate('t', { region: 'us' }).disposition).toBe('pass');
    expect(n.evaluate('t', { region: 3 }).disposition).toBe('error_blocked');
  });

  it('exists never makes a pattern unevaluable', () => {
    const e = ev('          override:\n            exists: true\n');
    expect(e.evaluate('t', { override: 'x' }).disposition).toBe('block');
    expect(e.evaluate('t', {}).disposition).toBe('pass');
    expect(e.evaluate('t', null).disposition).toBe('pass');
  });

  it('matches applies to strings only', () => {
    const e = ev('          email:\n            matches: "@outside\\\\.com$"\n');
    expect(e.evaluate('t', { email: 'a@outside.com' }).disposition).toBe('block');
    expect(e.evaluate('t', { email: 'a@inside.com' }).disposition).toBe('pass');
    expect(e.evaluate('t', { email: ['a@outside.com'] }).disposition).toBe('error_blocked');
  });

  it('wildcard tool matches any tool name', () => {
    const e = ev('          force:\n            eq: true\n', "'*'");
    expect(e.evaluate('anything', { force: true }).disposition).toBe('block');
  });

  it('custom method_field is honoured', () => {
    const e = new ToolPolicyEvaluator(
      parsePolicySource(
        minimal(
          '  - id: r\n    description: d\n    action_patterns:\n      - type: tool_call\n        tool: t\n        method: delete\n        method_field: op.name\n    disposition: block\n',
        ),
        'p.yaml',
      ).document.rules,
    );
    expect(e.evaluate('t', { op: { name: 'delete' } })).toMatchObject({
      disposition: 'block',
      toolMethod: 'delete',
    });
    expect(e.evaluate('t', { method: 'delete' }).disposition).toBe('error_blocked');
  });
});
