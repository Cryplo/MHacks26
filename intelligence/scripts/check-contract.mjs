// Verifies the frozen contract mirror is byte-identical to the agreed hash.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const EXPECTED = '2753b3c5c1eb16106f1a1eb69fc84174aa3c733eb5e6450927d5b60f98083a97';
const path = fileURLToPath(new URL('../contract/behavior-v1.ts', import.meta.url));
const actual = createHash('sha256').update(readFileSync(path)).digest('hex');
if (actual !== EXPECTED) {
  console.error(`contract drift: expected ${EXPECTED}, got ${actual}`);
  process.exit(1);
}
console.log(`contract ok ${actual}`);
