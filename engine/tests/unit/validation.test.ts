import { describe,it,expect } from 'vitest';
import { tinyPark,tinyPopulation,tinyManifest } from '../../fixtures/tiny.js';
import { validatePopulation,validateConfig,validateScenario } from '../../src/domain/schemas.js';
import { validatePark,encodeBase64,Navigation,UNREACHABLE } from '../../src/navigation/grid.js';
import { hashBytes } from '../../src/domain/primitives.js';
import { createCore,PHASES } from '../../src/domain/state.js';
describe('Manifest foundation',()=>{
  it('A-01 creates twelve future guests without premature admissions',()=>{
    const p=tinyPark(),pop=tinyPopulation(p),s=createCore('run',tinyManifest(p,pop),p,pop);
    expect(Object.keys(s.persons)).toHaveLength(12);expect(s.totals.admitted).toBe(0);
    expect(Object.values(s.persons).every(p=>p.state==='not_arrived')).toBe(true);expect(PHASES).toHaveLength(7);
  });
  it.each(['empty','duplicate','missing','orphan','guardian','money','time','hash','count','height'])('A-01 rejects %s population',problem=>{
    const p=tinyPark(),pop=tinyPopulation(p);
    if(problem==='empty')pop.personas=[];
    if(problem==='duplicate')pop.personas[1]=pop.personas[0]!;
    if(problem==='missing')pop.groups[0]!.memberIds.push('missing');
    if(problem==='orphan')pop.personas[0]!.groupId='other';
    if(problem==='guardian')pop.groups[0]!.guardianIds=['a1'];
    if(problem==='money')pop.groups[0]!.startingBalanceCents=-1;
    if(problem==='time')pop.groups[0]!.arrivalMs=pop.groups[0]!.plannedDepartureMs;
    if(problem==='hash')pop.parkHash='0'.repeat(64);
    if(problem==='count')pop.crowd.guestCount++;
    if(problem==='height')pop.personas[0]!.heightCm=999;
    expect(()=>validatePopulation(pop,p)).toThrow();
  });
  it('A-01 rejects unsupported flags, non-boundary scenarios, fallback experiments',()=>{
    const m=tinyManifest();m.config.features.splitGroups=true;expect(()=>validateConfig(m.config)).toThrow();
    m.config.features.splitGroups=false;m.config.mode='experiment';m.config.fallback='live_timeout_v1';expect(()=>validateConfig(m.config)).toThrow();
    m.scenario.events=[{id:'x',atMs:1,order:0,change:{kind:'pass_price',unitPriceCents:100}}];expect(()=>validateScenario(m.scenario,tinyPark())).toThrow();
  });
  it.each(['hash','dimensions','overlap','orphan','disconnected','vehicles'])('A-02 rejects %s park',problem=>{
    const p=tinyPark();
    if(problem==='hash')p.grid.cellsSha256='0'.repeat(64);
    if(problem==='dimensions')p.grid.width++;
    if(problem==='overlap')p.queueZones[0]!.cellIndices.push(p.queueZones[0]!.cellIndices[0]!);
    if(problem==='orphan')p.queueZones=[];
    if(problem==='disconnected')p.places[0]!.entrance={xM:0.5,yM:0.5};
    if(problem==='vehicles'){const s=p.places[2]!.service;if(s.kind==='ride')s.dispatchMs=5000;}
    expect(()=>validatePark(p)).toThrow();
  });
  it('A-03 uses stable flow ties, no queue shortcuts, swept walls and diagonal guards',()=>{
    const {navigation:n}=validatePark(tinyPark());expect(n.walkable(92)).toBe(false);
    expect(n.next({xM:2.5,yM:2.5},{xM:4.5,yM:4.5})).toEqual({xM:3.5,yM:3.5});
    expect(n.clearSegment({xM:2.5,yM:2.5},{xM:20.5,yM:2.5})).toBe(false);
    const cells=Uint8Array.from([1,0,0,1]);const grid={...tinyPark().grid,width:2,height:2,cellsBase64:encodeBase64(cells),cellsSha256:hashBytes(cells)};
    const diagonal=new Navigation(grid);expect(diagonal.field({xM:.5,yM:.5})[3]).toBe(UNREACHABLE);
    expect(diagonal.clearSegment({xM:.5,yM:.5},{xM:1.5,yM:1.5})).toBe(false);
  });
});
