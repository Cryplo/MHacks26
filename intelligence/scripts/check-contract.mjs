// Verifies the frozen contract mirror is byte-identical to the agreed hash.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const EXPECTED = '38502f63cf2a63f750658ae3e771a5429cd15eb9df4c66b20869970d177c40f6';
const path = fileURLToPath(new URL('../contract/behavior-v1.ts', import.meta.url));
const actual = createHash('sha256').update(readFileSync(path)).digest('hex');
if (actual !== EXPECTED) {
  console.error(`contract drift: expected ${EXPECTED}, got ${actual}`);
  process.exit(1);
}
console.log(`contract ok ${actual}`);
