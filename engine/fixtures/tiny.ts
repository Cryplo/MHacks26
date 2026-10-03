import type { ParkBundle,PopulationManifest,RunConfig,RunManifest,ArtifactRef } from '../contract/behavior-v1.js';
import { hash,hashBytes } from '../src/domain/primitives.js';
import { encodeBase64 } from '../src/navigation/grid.js';
export function tinyPark():ParkBundle {
  const width=20,height=16,cells=new Uint8Array(width*height);
  for(let y=1;y<height-1;y++)for(let x=1;x<width-1;x++)cells[y*width+x]=2;
  const queueCells=[92,93,94,112,113,114];queueCells.forEach(i=>{cells[i]=4;});
  const basic={queueZoneId:null,minHeightCm:null,thrill:0,board:null,notice:null};
  return {contractVersion:'behavior.v1',parkId:'tiny-synthetic',revision:'1',label:'Synthetic engine fixture',openLocal:'09:00',closeAfterMs:3600000,
    grid:{width,height,cellM:1,encoding:'u8-row-major-v1',cellsBase64:encodeBase64(cells),cellsSha256:hashBytes(cells),grassWalkable:false},
    places:[
      {...basic,id:'entrance',name:'Entry',kind:'entrance',entrance:{xM:2.5,yM:2.5},service:{kind:'none'}},
      {...basic,id:'exit',name:'Exit',kind:'exit',entrance:{xM:2.5,yM:12.5},service:{kind:'none'}},
      {...basic,id:'ride',name:'Test ride',kind:'ride',entrance:{xM:11.5,yM:5.5},queueZoneId:'ride-zone',service:{kind:'ride',seats:8,vehicles:1,dispatchMs:120000,durationMs:90000,turnaroundMs:30000,passShareBps:5000,passEnabled:true},board:{kind:'fixed',lowerMin:2,upperMin:2,text:'Test ride — 2 minutes'}},
      {...basic,id:'food',name:'Test food',kind:'food',entrance:{xM:15.5,yM:11.5},service:{kind:'counter',servers:2,serviceMs:10000,activityMs:15000,products:[{id:'meal',label:'Meal',unitPriceCents:500}]},notice:{channel:'aroma',text:'Fresh food',radiusM:2,cooldownMs:600000}},
      {...basic,id:'rest',name:'Bench',kind:'scenery',entrance:{xM:6.5,yM:10.5},service:{kind:'rest',durationMs:30000}},
    ],queueZones:[{id:'ride-zone',placeId:'ride',cellIndices:queueCells,entry:{xM:11.5,yM:5.5},exit:{xM:11.5,yM:4.5}}],routeProfiles:[],
    pass:{productId:'day-pass',unitPriceCents:1500,unit:'per_guest',validity:'remaining_day'}};
}
export function tinyPopulation(park=tinyPark(),count=12):PopulationManifest {
  const personas:PopulationManifest['personas']=[],groups:PopulationManifest['groups']=[];
  for(let i=0;i<count;i+=3){
    const groupId=`g${i}`,memberIds=Array.from({length:Math.min(3,count-i)},(_,j)=>`a${i+j}`);
    groups.push({groupId,memberIds,leaderId:memberIds[0]!,guardianIds:[memberIds[0]!],rallyPlaceId:'rest',walletId:`w${i}`,startingBalanceCents:20000,arrivalMs:Math.floor(i/3)*5000,plannedDepartureMs:1800000});
    memberIds.forEach((agentId,j)=>personas.push({agentId,groupId,archetype:'young_family',role:j===0?'parent':'child',ageYears:j===0?35:8+j,heightCm:j===0?170:125,walkSpeedMps:j===0?1.3:1,thrillPreference:0.5,initialNeeds:{hunger:30,fatigue:10,patience:80,fun:50},hungerPerHour:10,fatiguePerKm:8,patiencePerMinute:1,familiarity:0.5,hasApp:j===0,language:'en',phoneActiveUntilMs:null,stroller:false,mobilityRestricted:false,occasion:'fixture',mustDoPlaceIds:['ride'],backstory:'Synthetic test guest.'}));
  }
  return {contractVersion:'behavior.v1',populationId:'tiny-population',crowd:{guestCount:count,seed:'seed-001',shares:{young_family:1,teens:0,couple:0,thrill_seekers:0,seniors:0,solo:0},contextNotes:'Synthetic fixture',generatorVersion:'fixture-v1'},parkHash:hash(park),personas,groups,proseVersion:'fixture-v1',randomVersion:'behavior-rng-v1',diversity:[]};
}
export function fixtureRef(kind:ArtifactRef['kind'],value:unknown):ArtifactRef {
  const bytes=new TextEncoder().encode(JSON.stringify(value));return {artifactId:`fixture-${kind}`,kind,sha256:hashBytes(bytes),byteLength:bytes.length,mediaType:'application/json',contractVersion:'behavior.v1'};
}
export function tinyConfig():RunConfig {return {mode:'mock',horizonMs:3600000,logicalStepMs:5000,movementStepMs:250,requestedSpeed:1,temperature:1,earlyDepartureThresholdMs:1800000,ratingEveryMs:1800000,visualFrameEveryMs:30000,checkpointEveryMs:300000,fallback:'forbidden',liveTimeoutMs:10000,features:{routeChoice:false,bumpReactions:false,splitGroups:false,speechBubbles:false,discountMessages:false},versions:{engine:'engine-v1',observation:'observation-v1',options:'options-v1',random:'behavior-rng-v1',persona:'fixture-v1',prompt:'fixture-v1',requestedModel:'mock-policy-v1',meter:'meter-v1',loading:'loading-v1',metrics:'metrics-v1',rubric:'rubric-v1',replay:'replay-v1',sourceCommit:'fixture'}};}
export function tinyManifest(park=tinyPark(),population=tinyPopulation(park)):RunManifest{return {contractVersion:'behavior.v1',park:fixtureRef('park',park),population:fixtureRef('population',population),scenario:{id:'baseline',revision:'1',label:'Mock baseline',events:[]},replicateSeed:'seed-001',config:tinyConfig(),experiment:null,initialCheckpoint:null,replayTape:null};}
