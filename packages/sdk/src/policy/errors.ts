import type { PolicyCheck, PolicyRuleType } from '../types.js';

const BRAND = Symbol.for('@quotagate/sdk/PolicyViolationError');

/**
 * Thrown (as a rejected promise) when a policy rule with action 'block' triggers.
 * QuotaGate never calls the Anthropic API for a blocked request.
 */
export class PolicyViolationError extends Error {
  override readonly name = 'PolicyViolationError';
  readonly policyId: string;
  readonly ruleName: string;
  readonly ruleType: PolicyRuleType | 'policy_engine_error';
  readonly reason: string;
  /** Every check evaluated before (and including) the blocking rule. */
  readonly policyChecks: PolicyCheck[];

  constructor(init: {
    policyId: string;
    ruleName: string;
    ruleType: PolicyRuleType | 'policy_engine_error';
    reason: string;
    policyChecks?: PolicyCheck[];
  }) {
    super(
      `QuotaGate policy "${init.policyId}" blocked the call (${init.ruleName}): ${init.reason}`,
    );
    Object.setPrototypeOf(this, new.target.prototype);
    this.policyId = init.policyId;
    this.ruleName = init.ruleName;
    this.ruleType = init.ruleType;
    this.reason = init.reason;
    this.policyChecks = init.policyChecks ?? [];
    Object.defineProperty(this, BRAND, { value: true });
  }

  // instanceof works across the ESM and CJS copies of the package (dual-package hazard).
  static override [Symbol.hasInstance](value: unknown): boolean {
    return typeof value === 'object' && value !== null && BRAND in value;
  }
}
