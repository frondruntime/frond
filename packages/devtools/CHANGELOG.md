# Changelog

## [0.7.0](https://github.com/frondruntime/frond/compare/devtools-v0.6.1...devtools-v0.7.0) (2026-11-25)


### ⚠ BREAKING CHANGES

* createRuntime requires the development and eventBufferSize options; leaving either out fails the type check and throws FrondRuntimeInvariantViolation at runtime. createTestRuntime defaults them to true and 512.
* Frond.MobX (createNode, the MobXNode types and FrondMobXProjectionError) is removed. Read node.result on the class node, or useNode in React.
* committed results are read-only and frozen in development; write through patchResult, setResult or an updater.
* useNode and useNodes throw FrondReactUsageError in development outside a MobX observer component, and do not rerender on result writes outside one.
* @frondruntime/react requires React 19 and suspends through React.use.

### Features

* @frondruntime/react requires React 19 and suspends through React.use. ([b079795](https://github.com/frondruntime/frond/commit/b0797955318525e649e6d21cd1d638968b0f8b97))
* committed results are read-only and frozen in development; write through patchResult, setResult or an updater. ([b079795](https://github.com/frondruntime/frond/commit/b0797955318525e649e6d21cd1d638968b0f8b97))
* createRuntime requires the development and eventBufferSize options; leaving either out fails the type check and throws FrondRuntimeInvariantViolation at runtime. createTestRuntime defaults them to true and 512. ([b079795](https://github.com/frondruntime/frond/commit/b0797955318525e649e6d21cd1d638968b0f8b97))
* Frond 0.7, the frozen committed snapshot result ([b079795](https://github.com/frondruntime/frond/commit/b0797955318525e649e6d21cd1d638968b0f8b97))
* Frond.MobX (createNode, the MobXNode types and FrondMobXProjectionError) is removed. Read node.result on the class node, or useNode in React. ([b079795](https://github.com/frondruntime/frond/commit/b0797955318525e649e6d21cd1d638968b0f8b97))
* useNode and useNodes throw FrondReactUsageError in development outside a MobX observer component, and do not rerender on result writes outside one. ([b079795](https://github.com/frondruntime/frond/commit/b0797955318525e649e6d21cd1d638968b0f8b97))


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @frondruntime/core bumped to 0.7.0
  * peerDependencies
    * @frondruntime/core bumped from 0.6.1 to 0.7.0

## [0.6.1](https://github.com/frondruntime/frond/compare/devtools-v0.6.0...devtools-v0.6.1) (2026-11-20)


### Miscellaneous Chores

* **devtools:** Synchronize frondruntime versions


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @frondruntime/core bumped to 0.6.1
  * peerDependencies
    * @frondruntime/core bumped from 0.6.0 to 0.6.1

## [0.6.0](https://github.com/frondruntime/frond/compare/devtools-v0.5.0...devtools-v0.6.0) (2026-11-20)


### ⚠ BREAKING CHANGES

* Frond 0.6, a synchronous core for Hermes ([#28](https://github.com/frondruntime/frond/issues/28))

### Features

* Frond 0.6, a synchronous core for Hermes ([#28](https://github.com/frondruntime/frond/issues/28)) ([3767a73](https://github.com/frondruntime/frond/commit/3767a73e655dadf75a081a6a57a84c3b1ef84a0b))


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @frondruntime/core bumped to 0.6.0
  * peerDependencies
    * @frondruntime/core bumped from 0.5.0 to 0.6.0

## [0.5.0](https://github.com/frondruntime/frond/compare/devtools-v0.4.0...devtools-v0.5.0) (2026-10-22)


### ⚠ BREAKING CHANGES

* report message, name, fingerprint, tags, and contexts change shape; createRuntimeEventReports returns [] for non-reportable records; dependency-caused failures no longer produce their own reports.

### Features

* report errors by failing node, once at the source ([#24](https://github.com/frondruntime/frond/issues/24)) ([b98e22e](https://github.com/frondruntime/frond/commit/b98e22eec5717dff958920935bf741f02cf5416c))


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @frondruntime/core bumped to 0.5.0
  * peerDependencies
    * @frondruntime/core bumped from 0.4.0 to 0.5.0

## [0.4.0](https://github.com/frondruntime/frond/compare/devtools-v0.3.0...devtools-v0.4.0) (2026-08-02)


### ⚠ BREAKING CHANGES

* apps on this release require @frondruntime/hub at the matching version. A 0.3.x hub refuses the attachment with a message naming both versions, rather than accepting it and silently dropping the stream.

### Features

* typed signal lane, hub protocol 2, and the lint gate ([#18](https://github.com/frondruntime/frond/issues/18)) ([7363e4e](https://github.com/frondruntime/frond/commit/7363e4e2c1ecc81ac140fff563289d97891cd34b))


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @frondruntime/core bumped to 0.4.0
  * peerDependencies
    * @frondruntime/core bumped from 0.3.0 to 0.4.0

## [0.3.0](https://github.com/frondruntime/frond/compare/devtools-v0.2.0...devtools-v0.3.0) (2026-07-28)


### ⚠ BREAKING CHANGES

* **devtools:** `EncodedNodeSnapshot` drops `label` and `key`. `label` was a presentation formatting of `tag` and `key` is already embedded in `nodeId`; both were duplicated on every row of a graph read. `kind` stays — "node" versus "resource" is not recoverable from either and decides whether release semantics apply. **`HUB_PROTOCOL_VERSION` ships at 1**, not 3: the development history moved it to 2 and then 3 before this package existed on npm, and it was reset before release so the number counts published generations. Nothing outside this repo ever spoke 2 or 3.

### Features

* **devtools:** runtime devtools, the frond-hub daemon, and MCP state reads ([#16](https://github.com/frondruntime/frond/issues/16)) ([0f3947e](https://github.com/frondruntime/frond/commit/0f3947ef4d51effd43f158390c9105aef5aae4b4))


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @frondruntime/core bumped to 0.3.0
  * peerDependencies
    * @frondruntime/core bumped from 0.2.0 to 0.3.0

## Changelog
