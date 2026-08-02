// Rot alarm for the official skills: every skills/*/SKILL.md must carry a
// version stamp matching the released core major.minor. When a release bumps
// packages/core, this fails until each skill is re-reviewed and restamped —
// that forced review is the point, not an inconvenience.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const manifest = JSON.parse(
  await readFile(join(root, ".release-please-manifest.json"), "utf8")
) as Record<string, string>;

const coreVersion = manifest["packages/core"];
if (coreVersion === undefined) {
  console.error("skills:check: packages/core missing from .release-please-manifest.json");
  process.exit(1);
}

const expected = coreVersion.split(".").slice(0, 2).join(".");
const stampPattern = /Describes: @frondruntime\/core (\d+\.\d+)/;

const entries = await readdir(join(root, "skills"), { withFileTypes: true });
const failures: string[] = [];

for (const entry of entries) {
  if (!entry.isDirectory()) {
    continue;
  }

  const skillPath = join(root, "skills", entry.name, "SKILL.md");
  const content = await readFile(skillPath, "utf8").catch(() => undefined);

  if (content === undefined) {
    failures.push(`${entry.name}: missing SKILL.md`);
    continue;
  }

  const stamp = content.match(stampPattern)?.[1];

  if (stamp === undefined) {
    failures.push(`${entry.name}: missing "Describes: @frondruntime/core <major.minor>" stamp`);
  } else if (stamp !== expected) {
    failures.push(`${entry.name}: stamped ${stamp}, released core is ${expected} — re-review and restamp`);
  }
}

if (failures.length > 0) {
  console.error(`skills:check failed against core ${coreVersion}:`);
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

console.log(`skills:check ok: all skills stamped ${expected} (core ${coreVersion})`);
