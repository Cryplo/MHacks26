import { writeFileSync } from 'node:fs';
import { tinyPark,tinyPopulation } from '../fixtures/tiny.js';
const park=tinyPark();
writeFileSync(new URL('../fixtures/tiny-park.json',import.meta.url),JSON.stringify(park,null,2)+'\n');
writeFileSync(new URL('../fixtures/tiny-population.json',import.meta.url),JSON.stringify(tinyPopulation(park),null,2)+'\n');
