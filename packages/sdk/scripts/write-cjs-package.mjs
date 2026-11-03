// Marks dist/cjs as CommonJS so Node resolves the dual build correctly
// (the package root is "type": "module").
import { writeFileSync } from 'node:fs';

writeFileSync(
  new URL('../dist/cjs/package.json', import.meta.url),
  JSON.stringify({ type: 'commonjs' }, null, 2) + '\n',
);
