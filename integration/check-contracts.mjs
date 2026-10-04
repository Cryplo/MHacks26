import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
export const contractHash = '2753b3c5c1eb16106f1a1eb69fc84174aa3c733eb5e6450927d5b60f98083a97';
export async function checkContracts(root, partial = false) {
  const results = [];
  for (const lane of ['engine', 'intelligence', 'experience']) {
    try {
      const bytes = await readFile(resolve(root, lane, 'contract/behavior-v1.ts'));
      const hash = createHash('sha256').update(bytes).digest('hex');
      if (hash !== contractHash) throw new Error(`${lane}: frozen contract drift (${hash})`);
      results.push(`${lane}: verified`);
    } catch (error) {
      if (partial && error.code === 'ENOENT' && lane !== 'engine') results.push(`${lane}: absent (partial mode)`);
      else throw error;
    }
  }
  return results;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  console.log((await checkContracts(root, process.argv.includes('--partial'))).join('\n'));
}
