import { tinyPark } from "./tiny.js";
import { hashBytes } from "../src/domain/primitives.js";
import { encodeBase64 } from "../src/navigation/grid.js";
export function loadPark() {
  const park = tinyPark(),
    width = 200,
    height = 150,
    cells = new Uint8Array(width * height);
  for (let y = 1; y < height - 1; y++)
    for (let x = 1; x < width - 1; x++) cells[y * width + x] = 2;
  for (const zone of park.queueZones) {
    zone.cellIndices = zone.cellIndices.map(
      (i) => Math.floor(i / 20) * width + (i % 20),
    );
    for (const cell of zone.cellIndices) cells[cell] = 4;
  }
  park.parkId = "load-synthetic";
  park.grid = {
    ...park.grid,
    width,
    height,
    cellsBase64: encodeBase64(cells),
    cellsSha256: hashBytes(cells),
  };
  while (park.places.length < 15) {
    const i = park.places.length;
    park.places.push({
      ...park.places[4]!,
      id: `rest${i}`,
      name: `Rest ${i}`,
      entrance: { xM: 20.5 + i * 8, yM: 30.5 + i * 4 },
    });
  }
  return park;
}
