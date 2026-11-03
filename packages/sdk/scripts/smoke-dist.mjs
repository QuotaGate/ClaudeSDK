// Verifies the built ESM and CJS entry points load and expose the public API.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const esm = await import('@quotagate/sdk');
const cjs = require('@quotagate/sdk');

for (const [label, mod] of [
  ['esm', esm],
  ['cjs', cjs],
]) {
  for (const name of ['QuotaGate', 'quotagateNoop', 'PolicyViolationError', 'SDK_VERSION']) {
    if (!(name in mod)) throw new Error(`${label} build is missing export "${name}"`);
  }
}
const err = new cjs.PolicyViolationError({
  policyId: 'p',
  ruleName: 'r',
  ruleType: 'token_budget',
  reason: 'x',
  policyChecks: [],
});
if (!(err instanceof esm.PolicyViolationError)) {
  throw new Error('PolicyViolationError instanceof fails across ESM/CJS builds');
}
process.stdout.write(`dist smoke test ok (esm + cjs, v${esm.SDK_VERSION})\n`);
