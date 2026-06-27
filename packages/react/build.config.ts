import { rm } from "node:fs/promises";

await rm("dist", { force: true, recursive: true });

const result = Bun.spawnSync({
  cmd: [
    process.execPath,
    "build",
    "src/index.ts",
    "src/testing/index.ts",
    "--outdir=./dist",
    "--target=browser",
    "--format=esm",
    "--packages=external",
    "--sourcemap=external",
    "--splitting",
    "--production",
    "--keep-names",
  ],
  stderr: "inherit",
  stdout: "inherit",
});

if (result.exitCode !== 0) {
  throw new Error(`React package JavaScript build failed with exit code ${result.exitCode}.`);
}
