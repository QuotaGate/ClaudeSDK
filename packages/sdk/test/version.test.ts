import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as sdk from '../src/index.js';

describe('package surface', () => {
  it('SDK_VERSION matches package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    expect(sdk.SDK_VERSION).toBe(pkg.version);
  });

  it('exports the minimal public API', () => {
    expect(typeof sdk.QuotaGate).toBe('function');
    expect(typeof sdk.quotagateNoop).toBe('function');
    expect(typeof sdk.PolicyViolationError).toBe('function');
  });
});
