# @frondruntime/rootstock

Rootstock is the planned Effect-first backend contract companion for Frond.

It will own server-side resource and action contracts, runtime execution helpers, and transport projections that can be consumed by Frond clients. It is intentionally private while the package boundary is being developed.

## Status

This package is scaffolded for public development, but it is not published yet.

## Development

```sh
bun ../../build.ts rootstock
bun --conditions=source test
```

Release notes for this package will be generated from Conventional Commits after the package is made publishable.
