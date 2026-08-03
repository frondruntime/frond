---
name: official-skills-routing
description: Use when working inside this repository on any Frond-consumer-facing topic - node authoring, graph topology, node testing, React consumption, debugging, or review. Routes to the official public skills under skills/, which are the source of truth for all of it, so repo-internal guidance never drifts from what consumers are told.
---

# Official Skills Routing

Frond API doctrine is maintained in the public skills under `skills/`
(repo-relative from the repository root). They are the source of truth for
consumers and for work inside this repository alike.

| Topic | Load |
|---|---|
| Authoring or migrating nodes | `skills/frond-node-authoring/SKILL.md` |
| What earns a vertex, edges, keys | `skills/frond-graph-topology/SKILL.md` |
| Testing nodes, drivers, lifecycle | `skills/frond-node-testing/SKILL.md` |
| React consumption and bootstrap | `skills/frond-react/SKILL.md` |
| Diagnosing runtime behavior, the hub | `skills/frond-debugging/SKILL.md` |
| Reviewing any of the above | `skills/frond-review/SKILL.md` |

Load the matching file rather than relying on repo-internal guidance for
authoring rules, target shape, migration workflow, or anti-patterns.

The rest of `.agents/skills` is repo-maintainer-facing — tooling, release,
structure, review process. When an internal skill overlaps one of the six
above on Frond API behavior, the public skill wins; fix the internal one
instead of carrying a second answer.
