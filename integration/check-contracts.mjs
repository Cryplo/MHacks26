import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
export const contractHash = 'c25776a4883f70c71e8b4991dabc1b7a641baa8baeb615b1cfc145c0b8f1aac4';
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
