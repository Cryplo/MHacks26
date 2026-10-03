import {writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {localOperator} from './local-client.js';
import {makeTape} from '../src/replay/tape.js';
import type {Checkpoint} from '../src/replay/checkpoint.js';
const [runId,directory]=process.argv.slice(2);if(!runId||!directory)throw new Error('Usage: tsx tools/export-run.ts RUN_ID OUTPUT_DIRECTORY');
const client=await localOperator();
try{
 const r=await client.command('checkpointRun',{runId},randomUUID());if(!r.ok)throw new Error(r.error.message);
 const bytes=await client.getArtifact(r.result.checkpoint),checkpoint=JSON.parse(new TextDecoder().decode(bytes)) as Checkpoint;
 await mkdir(directory,{recursive:true});await writeFile(resolve(directory,'checkpoint.json'),bytes);await writeFile(resolve(directory,'response-tape.json'),JSON.stringify(makeTape(checkpoint.state))+'\n');
 await writeFile(resolve(directory,'manifest.json'),JSON.stringify(await client.query('getManifest',{runId}))+'\n');console.log('Exported committed checkpoint, response tape and manifest. No lease tokens exported.');
}finally{await client.close();}
