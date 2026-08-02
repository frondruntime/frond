# Frond Official Skills

Agent skills for building applications with `@frondruntime/*`. Each skill is a
single `SKILL.md` designed for coding agents: strict rules, one golden path,
enumerated deviations, and mechanical checks.

## Install

With [skills.sh](https://skills.sh):

```sh
npx skills add <frond-repo>/skills
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

Skills reference each other by name; install the set together.

## Versioning

Skills ship with the release they describe. When the installed
`@frondruntime/*` source disagrees with a skill, the source wins — and that
disagreement is a bug; report it.
