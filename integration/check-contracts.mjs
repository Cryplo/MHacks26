import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
export const contractHash = '38502f63cf2a63f750658ae3e771a5429cd15eb9df4c66b20869970d177c40f6';
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
