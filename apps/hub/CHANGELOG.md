# Changelog

## [0.3.0](https://github.com/frondruntime/frond/compare/hub-v0.2.0...hub-v0.3.0) (2026-07-28)


### ⚠ BREAKING CHANGES

* **devtools:** `EncodedNodeSnapshot` drops `label` and `key`. `label` was a presentation formatting of `tag` and `key` is already embedded in `nodeId`; both were duplicated on every row of a graph read. `kind` stays — "node" versus "resource" is not recoverable from either and decides whether release semantics apply. **`HUB_PROTOCOL_VERSION` ships at 1**, not 3: the development history moved it to 2 and then 3 before this package existed on npm, and it was reset before release so the number counts published generations. Nothing outside this repo ever spoke 2 or 3.

### Features

* **devtools:** runtime devtools, the frond-hub daemon, and MCP state reads ([#16](https://github.com/frondruntime/frond/issues/16)) ([0f3947e](https://github.com/frondruntime/frond/commit/0f3947ef4d51effd43f158390c9105aef5aae4b4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @frondruntime/core bumped from 0.2.0 to 0.3.0
    * @frondruntime/devtools bumped from 0.2.0 to 0.3.0
    * @frondruntime/react bumped from 0.2.0 to 0.3.0

## Changelog
