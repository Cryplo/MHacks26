import { it, expect } from "vitest";
import { PNG } from "pngjs";
import { tinyPark } from "../../fixtures/tiny.js";
import { compilePNG, PALETTE } from "../../tools/compile-park.js";
import { decodeBase64 } from "../../src/navigation/grid.js";
it("A-02 exact palette import roundtrips and reports unknown pixels/dimensions", () => {
  const p = tinyPark(),
    png = new PNG({ width: p.grid.width, height: p.grid.height }),
    cells = decodeBase64(p.grid.cellsBase64),
    colors = new Map(
      Object.entries(PALETTE).map(([color, code]) => [
        code,
        Buffer.from(color, "hex"),
      ]),
    );
  cells.forEach((code, i) => png.data.set(colors.get(code as 0)!, i * 4));
  const metadata = {
    ...p,
    grid: {
      width: p.grid.width,
      height: p.grid.height,
      cellM: 1,
      grassWalkable: false as const,
    },
  };
  expect(compilePNG(PNG.sync.write(png), metadata).park).toEqual(p);
  png.data[0] = 3;
  expect(() => compilePNG(PNG.sync.write(png), metadata)).toThrow(
    /Unknown palette colors.*"x":0,"y":0/,
  );
  expect(() =>
    compilePNG(PNG.sync.write(png), {
      ...metadata,
      grid: { ...metadata.grid, width: 50 },
    }),
  ).toThrow(/dimensions/);
});
