# Changelog

## [0.3.0](https://github.com/frondruntime/frond/compare/hub-v0.2.0...hub-v0.3.0) (2026-07-28)


### ⚠ BREAKING CHANGES

* **devtools:** `EncodedNodeSnapshot` drops `label` and `key`, so `HUB_PROTOCOL_VERSION` moves to 3. `label` was a presentation formatting of `tag` and `key` is already embedded in `nodeId`; both were duplicated on every row of a graph read. `kind` stays — "node" versus "resource" is not recoverable from either and decides whether release semantics apply.

### Features

* **devtools:** runtime devtools, the frond-hub daemon, and MCP state reads ([#16](https://github.com/frondruntime/frond/issues/16)) ([0f3947e](https://github.com/frondruntime/frond/commit/0f3947ef4d51effd43f158390c9105aef5aae4b4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @frondruntime/core bumped from 0.2.0 to 0.3.0
    * @frondruntime/devtools bumped from 0.2.0 to 0.3.0
    * @frondruntime/react bumped from 0.2.0 to 0.3.0

## Changelog
