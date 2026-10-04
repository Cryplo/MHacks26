/** CLI: npm run content:validate. Exits nonzero on any validation error. */
import { loadContent } from './load';
import { validateContent } from './validate-lib';

const errors = validateContent(loadContent());
if (errors.length) {
  console.error(`Harbor Lights content: ${errors.length} error(s)\n- ${errors.join('\n- ')}`);
  process.exit(1);
}
console.log('Harbor Lights content: OK (metadata, references, palette, queue ownership, services, presets).');
console.log('Note: Engine compiler reachability/field validation is separate; run npm run content:compile when engine/ exists.');
