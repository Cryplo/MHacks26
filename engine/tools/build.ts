import { build } from "esbuild";
await build({
  entryPoints: ["client/index.ts"],
  outfile: "client/dist/browser.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
});
await build({
  entryPoints: ["client/index.ts"],
  outfile: "client/dist/node.js",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  packages: "external",
  sourcemap: true,
});
