import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { QuotaGate } from '../src/quotagate.js';
import { PolicyFileError, ToolCallDeniedError } from '../src/governance/errors.js';
import { canonicalJson } from '../src/governance/hash.js';
import {
  WebhookDispatcher,
  signWebhook,
  type ViolationPayload,
} from '../src/governance/webhook.js';
import type { AuditEvent, QuotaGateInitOptions } from '../src/governance/types.js';
import { baseParams, createMockAnthropic, decodeBody, tick } from './helpers.js';

const FINTECH = fileURLToPath(new URL('../examples/policies/fintech.yaml', import.meta.url));
const SECRET = 'whsec_test_0123456789abcdef';
const SENSITIVE = ['A99321', 'Summarize this contract', 'meta-secret-xyz', 'IR', 'pw-hunter2'];
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

interface Harness {
  qg: QuotaGate;
  events: AuditEvent[];
  logs: string[];
  posts: { url: string; headers: Record<string, string>; body: string }[];
}

async function setup(
  extra: Partial<QuotaGateInitOptions> = {},
  respond: (n: number) => number = () => 200,
): Promise<Harness> {
  const events: AuditEvent[] = [];
  const logs: string[] = [];
  const posts: Harness['posts'] = [];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith('https://hooks.test')) {
      posts.push({
        url: u,
        headers: init?.headers as Record<string, string>,
        body: String(init?.body),
      });
      return new Response('receiver says: echo of something sensitive A99321', {
        status: respond(posts.length),
      });
    }
    return new Response(JSON.stringify({ accepted: 1, rejected: 0 }), { status: 200 });
  });
  const qg = await QuotaGate.init(
    {
      policyFile: FINTECH,
      agentId: 'agent-1',
      onAuditEvent: (e) => void events.push(e),
      webhook: { url: 'https://hooks.test/qg', secret: SECRET, retryDelaysMs: [1, 1] },
      fetch: fetchMock as unknown as typeof fetch,
      ...extra,
    },
    { logger: (m) => void logs.push(m) },
  );
  return { qg, events, logs, posts };
}

function expectNoSensitive(h: Harness, extra: string[] = []): void {
  const blob =
    JSON.stringify(h.events) + JSON.stringify(h.posts.map((p) => p.body)) + h.logs.join('\n');
  for (const s of [...SENSITIVE, ...extra]) expect(blob, s).not.toContain(s);
}

describe('QuotaGate.init', () => {
  it('loads the policy, exposes hash/version and emits policy_activated', async () => {
    const h = await setup({ policyChangeContext: { author: 'jdoe', commit: 'a1b2c3d' } });
    expect(h.qg.policy).toMatchObject({ fileName: 'fintech.yaml', policyVersion: '1.2.0' });
    expect(h.qg.policy?.policyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({
      event_type: 'policy_activated',
      policy_hash: h.qg.policy?.policyHash,
      policy_version: '1.2.0',
      change_author: 'jdoe',
      change_commit: 'a1b2c3d',
      agent_id: 'agent-1',
      policy_file_name: 'fintech.yaml',
    });
    expect(h.events[0]?.event_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
  });

  it('throws and emits policy_load_failed for a missing or invalid policy file', async () => {
    const events: AuditEvent[] = [];
    await expect(
      QuotaGate.init(
        { policyFile: '/nope/prod.yaml', onAuditEvent: (e) => void events.push(e) },
        { logger: () => {} },
      ),
    ).rejects.toBeInstanceOf(PolicyFileError);
    expect(events[0]).toMatchObject({
      event_type: 'policy_load_failed',
      error_code: 'file_not_found',
      policy_file_name: 'prod.yaml',
    });
    await expect(
      QuotaGate.init(
        { policySource: { text: 'version: 1\nrules: 5\n', fileName: 'x.yaml' } },
        { logger: () => {} },
      ),
    ).rejects.toMatchObject({ code: 'invalid_type' });
  });

  it('rejects unsafe or ambiguous options', async () => {
    const quiet = { logger: () => {} };
    const src = {
      text: 'version: "1"\nrules: [{id: a, description: d, action_patterns: [{type: tool_call, tool: t}], disposition: block}]\n',
      fileName: 'p.yaml',
    };
    await expect(
      QuotaGate.init({ policySource: src, captureContent: true as unknown as false }, quiet),
    ).rejects.toThrow(/captureContent/);
    await expect(
      QuotaGate.init({ policySource: src, policies: [] } as QuotaGateInitOptions, quiet),
    ).rejects.toThrow(/inline/);
    await expect(QuotaGate.init({}, quiet)).rejects.toThrow(/exactly one/);
    await expect(QuotaGate.init({ policySource: src, policyFile: FINTECH }, quiet)).rejects.toThrow(
      /exactly one/,
    );
    await expect(
      QuotaGate.init(
        { policySource: src, webhook: { url: 'http://hooks.test', secret: SECRET } },
        quiet,
      ),
    ).rejects.toThrow(/https/);
    await expect(
      QuotaGate.init(
        { policySource: src, webhook: { url: 'https://hooks.test', secret: 'short' } },
        quiet,
      ),
    ).rejects.toThrow(/secret/);
    await expect(
      QuotaGate.init(
        { policySource: src, webhook: { url: 'https://u:p@hooks.test', secret: SECRET } },
        quiet,
      ),
    ).rejects.toThrow(/credentials/);
    await expect(
      QuotaGate.init({ policySource: src, policyVersion: '  ' }, quiet),
    ).rejects.toMatchObject({ code: 'invalid_policy_version' });
  });

  it('guardTool and checkToolCalls require init()', () => {
    const qg = new QuotaGate({}, { logger: () => {} });
    expect(() => qg.guardTool('t', () => 1)).toThrow(/QuotaGate.init/);
    expect(() => qg.checkToolCalls({})).toThrow(/QuotaGate.init/);
    expect(qg.policy).toBeUndefined();
  });
});

describe('guardTool', () => {
  it('runs allowed tools and records a metadata-only pass event without a webhook', async () => {
    const h = await setup();
    const exec = vi.fn(
      async (input: { method: string; account_id: string }) => `balance for ${input.account_id}`,
    );
    const guarded = h.qg.guardTool('account_management', exec);
    await expect(
      guarded({ method: 'get_balance', account_id: 'A99321' }, { sessionId: 'sess-1' }),
    ).resolves.toBe('balance for A99321');
    const ev = h.events.find((e) => e.event_type === 'tool_call_evaluated');
    expect(ev).toMatchObject({
      disposition: 'pass',
      session_id: 'sess-1',
      tool_name: 'account_management',
      tool_method: null, // get_balance is not declared in the policy, so it is not reported
      param_names: ['account_id', 'method'],
      action_payload_hash: null,
      rule_version: '1.2.0',
    });
    await h.qg.flush();
    expect(h.posts).toHaveLength(0);
    expectNoSensitive(h);
  });

  it('blocks prohibited calls without running the executor and sends a signed webhook', async () => {
    const h = await setup();
    const exec = vi.fn();
    const guarded = h.qg.guardTool('account_management', exec);
    const err = await guarded({ method: 'close_account', account_id: 'A99321' }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ToolCallDeniedError);
    expect(err).toMatchObject({ disposition: 'block', ruleId: 'no_account_closure' });
    expect(String((err as Error).message)).not.toContain('A99321');
    expect(exec).not.toHaveBeenCalled();

    await h.qg.flush();
    expect(h.posts).toHaveLength(1);
    const post = h.posts[0]!;
    const body = JSON.parse(post.body) as ViolationPayload;
    expect(body).toMatchObject({
      event: 'policy_violation',
      rule_id: 'no_account_closure',
      rule_version: '1.2.0',
      action_type: 'tool_call',
      action_summary: 'account_management.close_account called with [account_id, method]',
      disposition: 'block',
      escalate_to: 'compliance_webhook',
      delivery_attempt: 1,
      policy_hash: h.qg.policy?.policyHash,
    });
    const ts = post.headers['QuotaGate-Timestamp']!;
    const expected = `v1=${createHmac('sha256', SECRET).update(`${ts}.${post.body}`).digest('hex')}`;
    expect(post.headers['QuotaGate-Signature']).toBe(expected);
    expect(post.headers['QuotaGate-Event-Id']).toBe(body.event_id);
    expect(h.events.find((e) => e.event_type === 'webhook_delivery')).toMatchObject({
      related_event_id: body.event_id,
      delivery_status: 'delivered',
      delivery_attempts: 1,
      http_status: 200,
    });
    expectNoSensitive(h);
  });

  it('denies unevaluable calls (error_blocked) instead of passing them', async () => {
    const h = await setup();
    const exec = vi.fn();
    const guarded = h.qg.guardTool('payments', exec);
    for (const input of [
      { method: 'initiate_transfer', amount: '6000', beneficiary: { country: 'US' } },
      { method: 'initiate_transfer', beneficiary: { country: 'US' } },
      null,
      'initiate_transfer',
    ]) {
      await expect(guarded(input as never)).rejects.toMatchObject({
        disposition: 'error_blocked',
        reasonCode: 'condition_not_evaluable',
      });
    }
    expect(exec).not.toHaveBeenCalled();
    await h.qg.flush();
    expectNoSensitive(h);
  });

  it('require_human_review without a reviewer denies the call', async () => {
    const h = await setup();
    const exec = vi.fn();
    await expect(
      h.qg.guardTool(
        'payments',
        exec,
      )({ method: 'initiate_transfer', amount: 6000, beneficiary: { country: 'US' } }),
    ).rejects.toMatchObject({ disposition: 'escalated', ruleId: 'transfer_limit' });
    expect(exec).not.toHaveBeenCalled();
    expect(h.events.find((e) => e.event_type === 'review_resolved')).toMatchObject({
      review_outcome: 'no_reviewer',
      rule_id: 'transfer_limit',
    });
    await h.qg.flush();
    expectNoSensitive(h);
  });

  it('require_human_review runs the tool only when the reviewer approves', async () => {
    const reviews: unknown[] = [];
    let decision: 'approve' | 'deny' = 'approve';
    const h = await setup({
      onHumanReview: async (r) => {
        reviews.push(r);
        return decision;
      },
    });
    const exec = vi.fn(async () => 'sent');
    const guarded = h.qg.guardTool('payments', exec);
    const input = { method: 'initiate_transfer', amount: 6000, beneficiary: { country: 'US' } };
    await expect(guarded(input)).resolves.toBe('sent');
    expect(reviews[0]).toMatchObject({
      ruleId: 'transfer_limit',
      toolMethod: 'initiate_transfer',
      input,
    });
    decision = 'deny';
    await expect(guarded(input)).rejects.toMatchObject({ disposition: 'escalated' });
    expect(exec).toHaveBeenCalledTimes(1);
    const outcomes = h.events
      .filter((e) => e.event_type === 'review_resolved')
      .map((e) => e.review_outcome);
    expect(outcomes).toEqual(['approved', 'denied']);
    await h.qg.flush();
    expectNoSensitive(h);
  });

  it('reviewer errors, invalid answers and timeouts deny the call', async () => {
    const input = { method: 'initiate_transfer', amount: 6000, beneficiary: { country: 'US' } };
    const throwing = await setup({
      onHumanReview: () => {
        throw new Error('pw-hunter2 reviewer crashed');
      },
    });
    await expect(throwing.qg.guardTool('payments', vi.fn())(input)).rejects.toBeInstanceOf(
      ToolCallDeniedError,
    );
    expect(throwing.events.find((e) => e.event_type === 'review_resolved')?.review_outcome).toBe(
      'error',
    );
    expectNoSensitive(throwing);

    const odd = await setup({ onHumanReview: () => 'yes' as never });
    await expect(odd.qg.guardTool('payments', vi.fn())(input)).rejects.toBeInstanceOf(
      ToolCallDeniedError,
    );

    const slow = await setup({
      onHumanReview: () => new Promise(() => {}),
      humanReviewTimeoutMs: 20,
    });
    await expect(slow.qg.guardTool('payments', vi.fn())(input)).rejects.toBeInstanceOf(
      ToolCallDeniedError,
    );
    expect(slow.events.find((e) => e.event_type === 'review_resolved')?.review_outcome).toBe(
      'timeout',
    );
  });

  it('warn runs the tool and notifies', async () => {
    const h = await setup();
    await expect(
      h.qg.guardTool(
        'account_management',
        async () => 'frozen',
      )({ method: 'freeze_account', account_id: 'A99321' }),
    ).resolves.toBe('frozen');
    await h.qg.flush();
    expect(JSON.parse(h.posts[0]!.body)).toMatchObject({
      disposition: 'warn',
      rule_id: 'account_freeze_notice',
    });
  });

  it('executor errors propagate unchanged and are not logged', async () => {
    const h = await setup();
    const boom = new Error('pw-hunter2 downstream failure');
    await expect(
      h.qg.guardTool('account_management', () => {
        throw boom;
      })({ method: 'get_balance' }),
    ).rejects.toBe(boom);
    expectNoSensitive(h);
  });

  it('action_payload_hash is an HMAC of the canonical input when a key is configured', async () => {
    const h = await setup({ payloadHashKey: 'tenant-key-1' });
    const input = { method: 'get_balance', account_id: 'A99321' };
    await h.qg.guardTool('account_management', async () => 1)(input);
    const ev = h.events.find((e) => e.event_type === 'tool_call_evaluated')!;
    expect(ev.action_payload_hash).toBe(
      createHmac('sha256', 'tenant-key-1').update(canonicalJson(input)).digest('hex'),
    );
  });
});

describe('checkToolCalls', () => {
  it('evaluates every tool_use block and marks what may run', async () => {
    const h = await setup();
    const checks = h.qg.checkToolCalls(
      {
        content: [
          { type: 'text', text: 'Summarize this contract' },
          {
            type: 'tool_use',
            id: 'tu_1',
            name: 'account_management',
            input: { method: 'close_account', account_id: 'A99321' },
          },
          {
            type: 'tool_use',
            id: 'tu_2',
            name: 'account_management',
            input: { method: 'get_balance' },
          },
          { type: 'tool_use', id: 'tu_3', name: 'payments', input: 'garbage' },
        ],
      },
      { sessionId: 'sess-9' },
    );
    expect(checks.map((c) => [c.toolUseId, c.evaluation.disposition, c.allowed])).toEqual([
      ['tu_1', 'block', false],
      ['tu_2', 'pass', true],
      ['tu_3', 'error_blocked', false],
    ]);
    expect(h.qg.checkToolCalls(null)).toEqual([]);
    await h.qg.flush();
    expect(h.posts).toHaveLength(2);
    expectNoSensitive(h);
  });
});

describe('webhook dispatcher', () => {
  const payload = (id: string): ViolationPayload => ({
    event: 'policy_violation',
    quotagate_version: 'test',
    timestamp: new Date(0).toISOString(),
    event_id: id,
    session_id: null,
    agent_id: null,
    rule_id: 'r',
    matched_rule_ids: ['r'],
    rule_version: '1',
    policy_hash: null,
    action_type: 'tool_call',
    action_summary: 't called with [a]',
    disposition: 'block',
    escalate_to: null,
    latency_ms: 1,
  });

  function dispatcher(statuses: (number | 'throw')[], extra: { maxQueue?: number } = {}) {
    const results: unknown[] = [];
    const logs: string[] = [];
    const bodies: string[] = [];
    let i = 0;
    const fetchMock = vi.fn(async (_u: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body));
      const s = statuses[Math.min(i++, statuses.length - 1)]!;
      if (s === 'throw') throw new Error('ECONNRESET secret-token-in-error');
      return new Response('body-with-secret', { status: s });
    });
    const d = new WebhookDispatcher({
      url: 'https://hooks.test/path?token=query-secret',
      secret: SECRET,
      retryDelaysMs: [1, 1],
      fetch: fetchMock as unknown as typeof fetch,
      logger: (m) => void logs.push(m),
      onResult: (r) => void results.push(r),
      random: () => 0,
      ...extra,
    });
    return { d, results, logs, bodies, fetchMock };
  }

  it('retries 5xx and network errors, then delivers (3 attempts max)', async () => {
    const t = dispatcher(['throw', 503, 200]);
    t.d.enqueue(payload('e1'));
    await t.d.flush();
    expect(t.results).toEqual([
      { eventId: 'e1', status: 'delivered', attempts: 3, httpStatus: 200 },
    ]);
    expect(t.bodies.map((b) => (JSON.parse(b) as ViolationPayload).delivery_attempt)).toEqual([
      1, 2, 3,
    ]);
  });

  it('gives up after three attempts and logs without bodies, URLs queries or error text', async () => {
    const t = dispatcher([500]);
    t.d.enqueue(payload('e2'));
    await t.d.flush();
    expect(t.fetchMock).toHaveBeenCalledTimes(3);
    expect(t.results).toEqual([{ eventId: 'e2', status: 'failed', attempts: 3, httpStatus: 500 }]);
    const logText = t.logs.join('\n');
    expect(logText).toContain('e2');
    for (const s of ['body-with-secret', 'query-secret', SECRET, 'called with'])
      expect(logText).not.toContain(s);
  });

  it('does not retry non-retryable 4xx', async () => {
    const t = dispatcher([400]);
    t.d.enqueue(payload('e3'));
    await t.d.flush();
    expect(t.fetchMock).toHaveBeenCalledTimes(1);
    expect(t.results[0]).toMatchObject({ status: 'failed', attempts: 1, httpStatus: 400 });
  });

  it('is bounded: drops beyond maxQueue and reports it; enqueue never blocks', async () => {
    const t = dispatcher([200], { maxQueue: 2 });
    const started = Date.now();
    for (let i = 0; i < 5; i++) t.d.enqueue(payload(`q${i}`));
    expect(Date.now() - started).toBeLessThan(50);
    await t.d.flush();
    const statuses = (t.results as { status: string }[]).map((r) => r.status);
    expect(statuses.filter((s) => s === 'dropped').length).toBeGreaterThan(0);
    expect(statuses.filter((s) => s === 'delivered').length).toBeGreaterThan(0);
  });

  it('signWebhook matches the documented scheme', () => {
    expect(signWebhook('k'.repeat(16), 100, '{}')).toBe(
      `v1=${createHmac('sha256', 'k'.repeat(16)).update('100.{}').digest('hex')}`,
    );
  });

  it('allows http only with allowInsecureHttp', () => {
    expect(
      () =>
        new WebhookDispatcher({
          url: 'http://localhost:9/x',
          secret: SECRET,
          logger: () => {},
          onResult: () => {},
        }),
    ).toThrow(/https/);
    expect(
      () =>
        new WebhookDispatcher({
          url: 'http://localhost:9/x',
          secret: SECRET,
          allowInsecureHttp: true,
          logger: () => {},
          onResult: () => {},
        }),
    ).not.toThrow();
  });
});

describe('metadata-only Claude spans (init mode)', () => {
  it('exports spans without prompts, responses, metadata or error text, and audits request rules', async () => {
    const events: AuditEvent[] = [];
    const ingest: string[] = [];
    const posts: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).startsWith('https://hooks.test')) {
        posts.push(String(init?.body));
        return new Response('', { status: 200 });
      }
      ingest.push(JSON.stringify(decodeBody(init)));
      return new Response(
        JSON.stringify({
          accepted: 1,
          rejected: 1,
          errors: ['server echoed Summarize this contract'],
        }),
        { status: 200 },
      );
    });
    const logs: string[] = [];
    const qg = await QuotaGate.init(
      {
        apiKey: 'qg_test_key',
        projectId: 'proj_test',
        endpoint: 'https://ingest.test',
        policyFile: FINTECH,
        onAuditEvent: (e) => void events.push(e),
        webhook: { url: 'https://hooks.test/qg', secret: SECRET },
        fetch: fetchMock as unknown as typeof fetch,
      },
      { logger: (m) => void logs.push(m) },
    );
    const anthropic = createMockAnthropic();
    const claude = qg.wrap(anthropic as never) as unknown as typeof anthropic;
    await claude.messages.create(
      {
        ...baseParams,
        system: 'system prompt pw-hunter2',
        messages: [{ role: 'user', content: 'Summarize this contract. Card 4111 1111 1111 1111' }],
      },
      { quotagate: { traceId: 'trace-1', metadata: { note: 'meta-secret-xyz' } } } as never,
    );
    anthropic.messages.create.mockRejectedValueOnce(
      Object.assign(new Error('upstream said: Summarize this contract'), { status: 500 }),
    );
    await claude.messages.create(baseParams).catch(() => undefined);
    await tick(3);
    await qg.shutdown();

    const blob = ingest.join('\n');
    expect(blob).toContain('"captureContent":false');
    expect(blob).toContain('"metadata":{}');
    expect(blob).toContain('"errorMessage":"Error (HTTP 500)"');
    // Span and trace ids are random UUIDs, so a short numeric needle such as the card
    // fragment '4111' can occur inside one by chance (e.g. spanId ...b41111bf21c7).
    // Strip ids before the substring checks so the assertion tests content leakage only.
    const withoutIds = (s: string) => s.replace(UUID_RE, '<id>');
    for (const s of [
      'Summarize this contract',
      'pw-hunter2',
      'meta-secret-xyz',
      'Here is the summary',
      '4111',
    ]) {
      expect(withoutIds(blob), s).not.toContain(s);
      expect(withoutIds(JSON.stringify(events)), s).not.toContain(s);
      expect(withoutIds(posts.join('')), s).not.toContain(s);
      expect(withoutIds(logs.join('\n')), s).not.toContain(s);
    }
    // The request rule (pii_detection, warn) from the policy file still runs and is audited.
    const req = events.find(
      (e) => e.event_type === 'request_evaluated' && e.disposition === 'warn',
    );
    expect(req).toMatchObject({
      rule_id: 'card_numbers_in_prompt',
      session_id: 'trace-1',
      action_type: 'model_request',
      model: 'claude-opus-4-5',
    });
    expect(
      posts.some((p) => (JSON.parse(p) as ViolationPayload).rule_id === 'card_numbers_in_prompt'),
    ).toBe(true);
    expect(logs.join('\n')).toContain('ingest rejected 1 span(s)');
  });
});

describe('captureContent default (decision A3)', () => {
  it('new QuotaGate() no longer captures content unless opted in', async () => {
    const bodies: string[] = [];
    const fetchMock = vi.fn(async (_u: unknown, init?: RequestInit) => {
      bodies.push(JSON.stringify(decodeBody(init)));
      return new Response('{}', { status: 200 });
    });
    for (const captureContent of [undefined, true]) {
      const qg = new QuotaGate(
        {
          apiKey: 'k',
          projectId: 'p',
          endpoint: 'https://ingest.test',
          fetch: fetchMock as unknown as typeof fetch,
          captureContent,
        },
        { logger: () => {} },
      );
      const anthropic = createMockAnthropic();
      await qg.wrap(anthropic as never as typeof anthropic).messages.create(baseParams);
      await tick(3);
      await qg.shutdown();
    }
    expect(bodies[0]).not.toContain('Summarize this contract');
    expect(bodies[0]).toContain('"captureContent":false');
    expect(bodies[1]).toContain('Summarize this contract');
  });
});
