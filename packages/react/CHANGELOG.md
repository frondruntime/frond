# Changelog

## [0.1.0](https://github.com/frondruntime/frond/compare/react-v0.0.3...react-v0.1.0) (2026-07-15)


### ⚠ BREAKING CHANGES

* Node args must be canonical KeyInput values (JSON-shaped): functions, Dates, and class instances are rejected at compile time and at runtime with typed KeyErrors, including by React's arg fingerprinting. Action return values are no longer committed to node.result - update results exclusively through setResult/patchResult/setResultValidity. The snapshot API loses its purpose parameter (getSnapshotFor/getSnapshotSyncFor and RuntimeSnapshotPurpose removed; use getSnapshot/getSnapshotSync). The RuntimeEvents constructor namespace is removed; construct events as plain RuntimeEvent literals. Live-lease acquisition returns a Held | Failure | NodeMissing union that callers must narrow (Failure carries typed errors for acquisitions that recorded nothing). GraphFailure gains a ReleaseFailed variant. Driver.Effect pins its requirements channel to never. TimeBound result validity no longer overrides explicitly non-Current stored validity; runtime.stop() cleanup is uninterruptible and idempotent; event sinks deliver inline and are awaited before submissions settle.

### Features

* harden runtime lifecycle, enforce canonical args, unify result staging ([#11](https://github.com/frondruntime/frond/issues/11)) ([0a512e3](https://github.com/frondruntime/frond/commit/0a512e3084f86129bd35155d3780433e84b7e7c0))


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @frondruntime/core bumped to 0.1.0
  * peerDependencies
    * @frondruntime/core bumped from 0.0.3 to 0.1.0

## [0.0.3](https://github.com/frondruntime/frond/compare/react-v0.0.2...react-v0.0.3) (2026-06-30)


### Bug Fixes

* emit production JSX for published React dist ([#6](https://github.com/frondruntime/frond/issues/6)) ([af62ac4](https://github.com/frondruntime/frond/commit/af62ac4857c22231b4603765ad16a3535d484f51))


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @frondruntime/core bumped to 0.0.3
  * peerDependencies
    * @frondruntime/core bumped from 0.0.2 to 0.0.3

## [0.0.2](https://github.com/frondruntime/frond/compare/react-v0.0.1...react-v0.0.2) (2026-06-27)


### Bug Fixes

* prepare package build pipeline ([#2](https://github.com/frondruntime/frond/issues/2)) ([7dfd180](https://github.com/frondruntime/frond/commit/7dfd180d1a7ff85238c10b6fd1723b5e3e8a3c72))


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @frondruntime/core bumped to 0.0.2
  * peerDependencies
    * @frondruntime/core bumped from 0.0.1 to 0.0.2

## 0.0.1 (2026-06-27)


### Miscellaneous Chores

* **react:** Synchronize frondruntime versions


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @frondruntime/core bumped to 0.0.1
  * peerDependencies
    * @frondruntime/core bumped from 0.0.0 to 0.0.1
