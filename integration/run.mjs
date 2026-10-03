import { spawn } from 'node:child_process';
import { access, readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { checkContracts } from './check-contracts.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const partial=process.argv.includes('--partial');
const checkOnly=process.argv.includes('--check');
const smoke=process.argv.includes('--smoke');
const external=process.argv.includes('--external-db');
const children=new Set();
let stopping=false;
const env={...process.env,SPACETIME_URI:process.env.SPACETIME_URI??'http://127.0.0.1:3000',SPACETIME_DATABASE:process.env.SPACETIME_DATABASE??'mhacks-engine'};
function stop(){if(stopping)return;stopping=true;for(const c of children)c.kill('SIGTERM');const timer=setTimeout(()=>{for(const c of children)c.kill('SIGKILL');},3000);timer.unref();}
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{stop();process.exitCode=signal==='SIGINT'?130:143;});
function launch(command,args,cwd=root){const p=spawn(command,args,{cwd,env,stdio:'inherit'});children.add(p);p.on('exit',()=>children.delete(p));return p;}
function wait(p){return new Promise((resolve,reject)=>{p.once('error',reject);p.once('exit',(code,signal)=>code===0?resolve():reject(new Error(`Child failed (${code??signal})`)));});}
async function run(command,args,cwd=root){await wait(launch(command,args,cwd));}
try {
  console.log((await checkContracts(root,partial)).join('\n'));
  const lanes=partial?['engine']:['engine','intelligence','experience'];
  for(const lane of lanes){
    const path=resolve(root,lane);await access(resolve(path,'package-lock.json'));
    const pkg=JSON.parse(await readFile(resolve(path,'package.json'),'utf8'));
    if(!pkg.scripts?.build)throw new Error(`${lane} requires a build script`);
    if(!partial&&lane!=='engine'&&!pkg.scripts?.['dev:integration'])throw new Error(`${lane} requires dev:integration; see integration/README.md`);
    if(!checkOnly){await run('npm',['ci'],path);await run('npm',['run','build'],path);}
  }
  if(checkOnly)process.exit(0);
  const cli=env.SPACETIME_CLI??'spacetime';
  if(!external){
    const u=new URL(env.SPACETIME_URI);if(!['localhost','127.0.0.1'].includes(u.hostname))throw new Error('Managed database must use loopback');
    await mkdir(resolve(root,'engine/.local'),{recursive:true});
    const server=env.SPACETIME_SERVER??cli;
    const args=env.SPACETIME_SERVER?['--listen-addr',u.host,'--data-dir',resolve(root,'engine/.local/db')]:['start','--listen-addr',u.host,'--data-dir',resolve(root,'engine/.local/db')];
    const db=launch(server,args);db.once('exit',()=>{if(!stopping)stop();});
    const deadline=Date.now()+30000;let ready=false;
    while(Date.now()<deadline&&!stopping){try{const r=await fetch(`${env.SPACETIME_URI}/v1/ping`,{signal:AbortSignal.timeout(1000)});if(r.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,150));}
    if(!ready)throw new Error('Database startup timeout');
  }
  await run('npm',['ci'],resolve(root,'engine/module'));
  await run(cli,['publish',env.SPACETIME_DATABASE,'--server',env.SPACETIME_URI,'--module-path','module','--yes','--no-config'],resolve(root,'engine'));
  const park=partial?[]:[env.PARK_BUNDLE_PATH??resolve(root,'experience/assets/park.bundle.json')];
  if(park.length)await access(park[0]);
  await run('npm',['run','dev:seed','--',...park],resolve(root,'engine'));
  if(smoke){await run(process.execPath,[resolve(root,'integration/smoke.mjs'),...(partial?['--partial']:[])]);stop();}
  else {
    for(const lane of lanes.filter(l=>l!=='engine')){const child=launch('npm',['run','dev:integration'],resolve(root,lane));child.once('exit',()=>{if(!stopping)stop();});}
    console.log(partial?'Engine ready; no intelligence or experience lane launched.':'All configured lanes started.');
    if(external&&partial)console.log('External server remains running.');
  }
}catch(error){console.error(error.message);stop();process.exitCode=1;}
