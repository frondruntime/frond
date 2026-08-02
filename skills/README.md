# Frond Official Skills

Agent skills for building applications with `@frondruntime/*`. Each skill is a
single `SKILL.md` designed for coding agents: strict rules, one golden path,
enumerated deviations, and mechanical checks.

## Install

With [skills.sh](https://skills.sh) — the CLI auto-discovers the top-level
`skills/<name>/SKILL.md` layout:

```sh
npx skills add frondruntime/frond
```

Or copy the directories you need into your repository's skill location
(`.agents/skills/`, `.claude/skills/`, or equivalent).

## The Set

| Skill | Covers |
|---|---|
| `frond-node-authoring` | The golden authoring path: spec carriers, sealed/leaf nodes, modes, drivers, actions, cancellation, injection seams |
| `frond-graph-topology` | What earns a graph vertex, forbidden node shapes, edges and keys, intent dispatch for host capabilities |
| `frond-node-testing` | Harness, spec overrides, per-package testing contracts, deterministic operations, coverage by archetype |
| `frond-react` | Capability-poor React, consumption patterns, bridge components, composition-root bootstrap |
| `frond-debugging` | Evidence-first diagnosis, read phases, the devtools hub and its MCP tools |
| `frond-review` | The enforcement half: verdict model, mistake and drift sweeps, per-area gates |

Skills reference each other by name; install the set together.

## Local Supplements

These skills carry runtime doctrine only. Everything your product owns —
domain law, vendor-behavior gates, security policy, package naming, file
layout — belongs in a repo-local supplement skill layered on top, not in a
fork of these files.

- A supplement may **tighten** official rules (stricter boundaries, extra
  checks, narrower allowlists). It may never loosen them.
- On any API-shape disagreement, the official skill plus the installed
  `@frondruntime/*` source win. If you believe the golden path itself is
  wrong, open an issue or PR upstream instead of patching locally — a local
  fork of doctrine is how divergence starts.
- Give supplements their own checks; `frond-review` runs them under the same
  verdict model (see its Scope section).
- When an official skill absorbs a rule your supplement carried, delete the
  local copy in the same change that adopts the new skill version.

## Versioning

Skills ship with the release they describe; each `SKILL.md` ends with a
`Describes: @frondruntime/core <major.minor>` stamp. If you vendored these
skills, compare that stamp against your installed `@frondruntime/core` on
every upgrade — there is no automated check outside the frond repository.
When the installed `@frondruntime/*` source disagrees with a skill, the
source wins — and that disagreement is a bug; report it.
