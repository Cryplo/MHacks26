import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { checkContracts } from './check-contracts.mjs';
const root=fileURLToPath(new URL('..',import.meta.url)),partial=process.argv.includes('--partial');
console.log((await checkContracts(root,partial)).join('\n'));
function run(args,cwd){return new Promise((resolve,reject)=>{const p=spawn('npm',args,{cwd,env:process.env,stdio:'inherit'});for(const sig of ['SIGINT','SIGTERM'])process.once(sig,()=>p.kill(sig));p.once('error',reject);p.once('exit',c=>c===0?resolve():reject(new Error(`Smoke failed: ${c}`)));});}
if(partial){console.log('PARTIAL: real runtime with engine fixture worker; no B/C integration claim.');await run(['exec','--','tsx','tools/runtime-smoke.ts'],resolve(root,'engine'));}
else{
  const pkg=JSON.parse(await readFile(resolve(root,'intelligence/package.json'),'utf8'));
  if(!pkg.scripts?.['test:integration:engine'])throw new Error('Missing intelligence test:integration:engine: strict gate requires B mock setup/scenario/comparison through the frozen adapter.');
  await run(['run','test:integration:engine'],resolve(root,'intelligence'));
}
