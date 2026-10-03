import { PNG } from "pngjs";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { ParkBundle, CellCode } from "../contract/behavior-v1.js";
import { hash, hashBytes, ensure } from "../src/domain/primitives.js";
import { encodeBase64, validatePark } from "../src/navigation/grid.js";
export const PALETTE: Record<string, CellCode> = {
  "000000ff": 0,
  ffffffff: 1,
  "808080ff": 2,
  "00ff00ff": 3,
  ffff00ff: 4,
};
export function compilePNG(
  bytes: Uint8Array,
  metadata: Omit<ParkBundle, "grid"> & {
    grid: {
      width: number;
      height: number;
      cellM: number;
      grassWalkable: false;
    };
  },
): {
  park: ParkBundle;
  report: { hash: string; cells: number; destinations: number; valid: true };
} {
  const png = PNG.sync.read(Buffer.from(bytes));
  ensure(
    png.width === metadata.grid.width && png.height === metadata.grid.height,
    "PNG dimensions do not match explicit metadata",
  );
  const cells = new Uint8Array(png.width * png.height),
    unknown = new Map<
      string,
      { count: number; first: { x: number; y: number } }
    >();
  for (let i = 0; i < cells.length; i++) {
    const rgba = Buffer.from(png.data.subarray(i * 4, i * 4 + 4)).toString(
        "hex",
      ),
      code = PALETTE[rgba];
    if (code === undefined) {
      const old = unknown.get(rgba) ?? {
        count: 0,
        first: { x: i % png.width, y: Math.floor(i / png.width) },
      };
      old.count++;
      unknown.set(rgba, old);
    } else cells[i] = code;
  }
  ensure(
    unknown.size === 0,
    `Unknown palette colors: ${JSON.stringify([...unknown].map(([rgba, issue]) => ({ rgba, ...issue })))}`,
  );
  const park: ParkBundle = {
    ...metadata,
    grid: {
      ...metadata.grid,
      encoding: "u8-row-major-v1",
      cellsBase64: encodeBase64(cells),
      cellsSha256: hashBytes(cells),
    },
  };
  const { navigation } = validatePark(park);
  for (const p of park.places) navigation.field(p.entrance);
  return {
    park,
    report: {
      hash: hash(park),
      cells: cells.length,
      destinations: park.places.length,
      valid: true,
    },
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [png, metadata, output] = process.argv.slice(2);
  ensure(
    png && metadata && output,
    "Usage: tsx tools/compile-park.ts input.png metadata.json output.json",
  );
  const result = compilePNG(
    readFileSync(png),
    JSON.parse(readFileSync(metadata, "utf8")),
  );
  writeFileSync(output, JSON.stringify(result.park, null, 2) + "\n");
  writeFileSync(
    output + ".validation.json",
    JSON.stringify(result.report, null, 2) + "\n",
  );
  console.log(JSON.stringify(result.report));
}
