import type { BuiltInPiiPattern, PromptInjectionGroup } from '../types.js';

// ---------------------------------------------------------------------------
// PII (TECHNICAL_SPECS section 5). All patterns run client-side; matched values
// are never written to reasons, logs or spans.
// ---------------------------------------------------------------------------

export interface PiiPattern {
  regex: RegExp;
  /** Optional post-filter on each match (e.g. Luhn check). */
  validate?: (match: string) => boolean;
}

export const PII_PATTERNS: Record<BuiltInPiiPattern, PiiPattern> = {
  // ddd-dd-dddd, excluding invalid area/group/serial numbers (000, 666, 9xx; 00; 0000).
  ssn: { regex: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g },
  // 13-19 digits, optionally separated by single spaces or dashes, Luhn-valid.
  credit_card: { regex: /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g, validate: luhnValid },
  // Practical RFC 5322 "dot-atom" address.
  email: {
    regex:
      /[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}\b/g,
  },
  // (555) 123-4567, 555-123-4567, 555.123.4567, 555 123 4567, +1 555 123 4567.
  // A separator is required before the last four digits to avoid matching arbitrary numbers.
  phone_us: {
    regex:
      /(?<![\d-])(?:\+?1[\s.-]?)?(?:\([2-9]\d{2}\)\s?|[2-9]\d{2}[\s.-])[2-9]\d{2}[\s.-]\d{4}(?![\d-])/g,
  },
  // A DOB label followed by a date in a common format.
  date_of_birth: {
    regex:
      /\b(?:d\.?o\.?b\.?|date\s+of\s+birth|birth\s*date|birthday|born(?:\s+on)?)\s*[:\-#]?\s*(?:\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{2}-\d{2}|[A-Za-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}|\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]{3,9}\.?,?\s+\d{4})/gi,
  },
  // US passport: 9 digits or 1 letter + 8 digits (Next Generation). Requires a "passport"
  // label nearby, because a bare 9-digit number is far too common to flag on its own.
  passport_us: {
    regex: /\bpassport(?:\s*(?:no\.?|number|num\.?|#))?\s*[:#-]?\s*(?:[A-Za-z]\d{8}|\d{9})\b/gi,
  },
};

export const BUILT_IN_PII_PATTERNS = Object.keys(PII_PATTERNS) as BuiltInPiiPattern[];

export function luhnValid(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  if (/^(\d)\1+$/.test(digits)) return false; // 0000..., 1111... are not real cards
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

// ---------------------------------------------------------------------------
// Prompt injection (TECHNICAL_SPECS section 5b). Regex heuristics: low recall
// against a deliberate attacker; intended to catch naive/accidental injection.
// ---------------------------------------------------------------------------

export interface InjectionPattern {
  regex: RegExp;
  validate?: (match: string) => boolean;
}

export const PROMPT_INJECTION_GROUPS: Record<PromptInjectionGroup, InjectionPattern[]> = {
  override_instructions: [
    {
      // "ignore previous instructions", "disregard the system prompt", "forget all prior rules"
      regex:
        /\b(?:ignore|disregard|forget|override|bypass|neglect)\b[^.\n]{0,40}?\b(?:previous|prior|above|earlier|preceding|system|original|initial|existing|your|all|any)\b[^.\n]{0,25}?\b(?:instructions?|prompts?|rules|directives?|directions|guidelines|guardrails|constraints)\b/i,
    },
    {
      regex: /\b(?:new|updated|revised)\s+(?:system\s+)?instructions?\s*:/i,
    },
  ],
  role_hijack: [
    {
      // "you are now DAN" (capitalised persona name; case-sensitive on purpose)
      regex: /\b[Yy]ou\s+are\s+now\s+[A-Z][\w-]*/,
    },
    // "you are now an unrestricted AI", "you are now in developer mode"
    { regex: /\byou\s+are\s+now\s+(?:a|an|the|my|in|no\s+longer)\b/i },
    { regex: /\bfrom\s+now\s+on,?\s+you\s+(?:are|will\s+be|must\s+act|act)\b/i },
    { regex: /\bpretend\s+(?:to\s+be|you\s+are|that\s+you\s+are)\b/i },
    {
      regex:
        /\bact\s+as\s+(?:an?\s+)?(?:unrestricted|unfiltered|uncensored|jailbroken|evil|rogue)\b/i,
    },
    {
      regex: /\b(?:enter|enable|activate|switch\s+to)\s+(?:developer|dan|god|jailbreak)\s+mode\b/i,
    },
  ],
  system_prompt_exfil: [
    {
      regex:
        /\b(?:reveal|print|show|display|repeat|output|recite|leak|dump|share|tell\s+me|give\s+me|what\s+(?:is|are|was|were))\b[^.\n]{0,30}?\b(?:your|the)\s+(?:(?:full|entire|exact|original|initial|hidden|secret)\s+)?(?:system\s+(?:prompt|message|instructions)|initial\s+(?:prompt|instructions)|hidden\s+(?:prompt|instructions)|original\s+instructions|instructions\s+above)\b/i,
    },
  ],
  fake_delimiters: [
    { regex: /<\/?\s*(?:system|assistant|user|human|instructions?|system_prompt)\s*>/i },
    { regex: /(?:^|\n)\s*(?:Human|Assistant|System)\s*:/ },
    { regex: /\[\/?(?:INST|SYS)\]|<<\/?SYS>>/ },
    { regex: /<\|(?:im_start|im_end|system|user|assistant|endoftext)\|>/i },
  ],
  encoded_payload: [
    {
      // >= 200 base64 characters with mixed character classes (filters long words/URLs).
      regex: /[A-Za-z0-9+/]{200,}={0,2}/,
      validate: (m) => /[A-Z]/.test(m) && /[a-z]/.test(m) && /\d/.test(m),
    },
    // >= 128 hex characters (64+ bytes), longer than common hashes.
    { regex: /\b(?:0x)?[0-9a-fA-F]{128,}\b/ },
  ],
};

export const PROMPT_INJECTION_GROUP_NAMES = Object.keys(
  PROMPT_INJECTION_GROUPS,
) as PromptInjectionGroup[];
