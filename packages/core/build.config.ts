import { rm } from "node:fs/promises";

await rm("dist", { force: true, recursive: true });

await Bun.build({
  entrypoints: ["./src/index.ts", "./src/testing/index.ts"],
  format: "esm",
  outdir: "./dist",
  packages: "external",
  splitting: true,
  sourcemap: "external",
  target: "browser",
  tsconfig: "./tsconfig.build.json",
});
