# Skills Changelog

Doctrine changes per version stamp. One line per rule change; consumers
upgrading vendored skills read this to see what changed, not just that the
stamp moved.

## 0.4

Initial official set: frond-node-authoring, frond-graph-topology,
frond-node-testing, frond-react, frond-debugging, frond-review.

- Golden path: mode-first spec carriers, flavored factories, sealed/leaf
  dichotomy, async by default with effect by recorded confirmation.
- Injection seams limited to graph dependencies and spec overrides;
  platform splits sanctioned as a normal pattern.
- Alias/DI-point/test-seam vertices forbidden; staleness
  (snapshot-at-acquire) forbidden; intent dispatch replaces bind/unbind
  host ports for UI-owned capabilities (bind/unbind is migration-only).
- Node tests never mount React; dependency replacement is the only seam.
- Pre-graph exceptions: one membership principle (must work when the graph
  does not exist), two closed groups (polyfills, error reporting), one open
  host-demand group with do/don't examples, and a mandatory checklist.
- Local supplements defined: tighten-only, official-wins-on-API-shape,
  reviewed under the frond-review verdict model.
