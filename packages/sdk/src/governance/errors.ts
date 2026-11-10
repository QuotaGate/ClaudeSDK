import type { ToolDisposition } from './types.js';

const POLICY_FILE_BRAND = Symbol.for('@quotagate/sdk/PolicyFileError');
const TOOL_DENIED_BRAND = Symbol.for('@quotagate/sdk/ToolCallDeniedError');

/**
 * The policy file is missing, unreadable or invalid. `QuotaGate.init()` throws this, so an
 * agent never starts without a valid policy. The message names the file, line and field;
 * it never quotes file contents.
 */
export class PolicyFileError extends Error {
  override readonly name = 'PolicyFileError';
  readonly code: string;
  readonly fileName: string;
  readonly field: string | null;
  readonly line: number | null;
  readonly column: number | null;

  constructor(init: {
    code: string;
    fileName: string;
    detail: string;
    field?: string | null;
    line?: number | null;
    column?: number | null;
  }) {
    const loc = init.line ? `:${init.line}${init.column ? `:${init.column}` : ''}` : '';
    const field = init.field ? ` ${init.field}:` : '';
    super(`${init.fileName}${loc}:${field} ${init.detail} [${init.code}]`);
    Object.setPrototypeOf(this, new.target.prototype);
    this.code = init.code;
    this.fileName = init.fileName;
    this.field = init.field ?? null;
    this.line = init.line ?? null;
    this.column = init.column ?? null;
    Object.defineProperty(this, POLICY_FILE_BRAND, { value: true });
  }

  static override [Symbol.hasInstance](value: unknown): boolean {
    return typeof value === 'object' && value !== null && POLICY_FILE_BRAND in value;
  }
}

/**
 * Thrown by a guarded tool (`guardTool`) when the tool call must not run: a `block` rule
 * matched, the call could not be evaluated safely (`error_blocked`), or a
 * `require_human_review` rule matched and the review did not approve it (`escalated`).
 * The executor is never called. The message contains no input values.
 */
export class ToolCallDeniedError extends Error {
  override readonly name = 'ToolCallDeniedError';
  readonly toolName: string;
  readonly disposition: Exclude<ToolDisposition, 'pass' | 'warn'>;
  readonly ruleId: string | null;
  readonly matchedRuleIds: string[];
  readonly reasonCode: string;
  /** audit event id of the evaluation. */
  readonly eventId: string;

  constructor(init: {
    toolName: string;
    disposition: Exclude<ToolDisposition, 'pass' | 'warn'>;
    ruleId: string | null;
    matchedRuleIds: string[];
    reasonCode: string;
    eventId: string;
  }) {
    super(
      `QuotaGate denied tool "${init.toolName}" (${init.disposition}${
        init.ruleId ? `, rule ${init.ruleId}` : ''
      }, ${init.reasonCode})`,
    );
    Object.setPrototypeOf(this, new.target.prototype);
    this.toolName = init.toolName;
    this.disposition = init.disposition;
    this.ruleId = init.ruleId;
    this.matchedRuleIds = init.matchedRuleIds;
    this.reasonCode = init.reasonCode;
    this.eventId = init.eventId;
    Object.defineProperty(this, TOOL_DENIED_BRAND, { value: true });
  }

  static override [Symbol.hasInstance](value: unknown): boolean {
    return typeof value === 'object' && value !== null && TOOL_DENIED_BRAND in value;
  }
}
