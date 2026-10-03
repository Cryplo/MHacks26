// Verifies the frozen contract mirror is byte-identical to the agreed hash.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const EXPECTED = 'c25776a4883f70c71e8b4991dabc1b7a641baa8baeb615b1cfc145c0b8f1aac4';
const path = fileURLToPath(new URL('../contract/behavior-v1.ts', import.meta.url));
const actual = createHash('sha256').update(readFileSync(path)).digest('hex');
if (actual !== EXPECTED) {
  console.error(`contract drift: expected ${EXPECTED}, got ${actual}`);
  process.exit(1);
}
console.log(`contract ok ${actual}`);
