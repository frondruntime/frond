# Release Checklist

Use this checklist before publishing `@frondruntime/core`, `@frondruntime/react`, `@frondruntime/devtools`, and `@frondruntime/hub`.

## Policy

- Publish only from `master` after CI is green.
- Keep all four packages on the same version unless a release explicitly documents why only one package changes.
- Keep every internal `@frondruntime/*` dependency and peer dependency pinned to the release version. `publish.ts` fails the run if any of them points at a version other than the one being published, and `workspace:*` never survives to the tarball because the pack step uses `npm pack`.
- `@frondruntime/hub` ships as source under a `bun` shebang. `bunx @frondruntime/hub` works; `npx` does not, and there is no `dist` for it to assert on.
- `HUB_PROTOCOL_VERSION` lives in `@frondruntime/devtools` and the hub imports it, so the two must be published together. A devtools release that leaves the hub's pin behind produces a hub that refuses every current app.
- GitHub release PRs, tags, and Releases are managed by release-please. npm publish remains a local manual step.
- Treat npm publish as irreversible. Do not automate publish or add npm tokens/trusted publishing until the release policy explicitly changes.
- Treat public git tags as soft-irreversible. GitHub Releases and tags can be deleted or recreated, but consumers may already have fetched them.

## Release Metadata

Release metadata is handled by `.github/workflows/release.yml`.

On each push to `master`, release-please reads Conventional Commits and either:

- opens or updates a release PR with package version bumps and changelogs, or
- creates GitHub Releases and component tags after the release PR is merged.

The setup intentionally does not publish to npm. After release-please opens a release PR, the workflow checks out that release PR branch and runs `bun install` so `bun.lock` stays aligned with the version bumps.

Do not run `bun run publish:npm` or `bun run publish:npm:dry-run` from GitHub Actions. The publish script is local-only because the final publish step is interactive and may require npm 2FA.

All four packages use linked versions. Release-please tracks each of them in `.release-please-manifest.json`, updates workspace peer dependencies through the `node-workspace` plugin, and emits component tags instead of one shared tag.

Release-please owns no version string outside `package.json` and the manifest. The hub used to keep a second copy in `apps/hub/src/version.ts`, synced by an `extra-files` marker; it no longer has one. That marker is worth remembering as a failure mode: it rewrites a semver on the line it is found on, so a marker sitting one line off matches, replaces nothing, and reports success — a hub announcing a version it was not.

`apps/hub/src/version.ts` now reads `package.json` directly instead. `frond-hub --version` prints both numbers, `0.4.0 (protocol 2)`, because they answer different questions: the release says which build is installed, which is what a bug report needs, and the protocol says what that build will talk to, which is the only number an attaching app compares. The MCP handshake advertises the bare package version, which is what `serverInfo.version` is specified to mean. Nothing here is copied, so nothing can fall out of sync.

Use Conventional Commit subjects for release-driving commits:

```txt
feat: add runtime capability
fix: correct release cleanup failure reporting
```

Use `feat` for a minor bump before `1.0.0`, `fix` for a patch bump, and `!` or a `BREAKING CHANGE` footer for a breaking bump.

Squash-merge release-driving PRs. A normal merge commit can make release-please see both the merge commit and the original Conventional Commit, which can duplicate changelog entries.

If CI does not run on release-please PRs, add a repository secret named `RELEASE_PLEASE_TOKEN` with a fine-grained token that can create pull requests and push release branches. GitHub suppresses recursive workflow runs for events created by the default `GITHUB_TOKEN`.

## Local Verification

Run from the repository root for normal CI-equivalent verification:

```sh
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run effect:diagnostics
bun run test
bun run build
```

Before a release PR merge or public npm publish, run the full local package rehearsal:

```sh
bun run publish:npm:dry-run
```

The rehearsal must build, run `npm publish --dry-run` where possible, pack all four packages, install the packed tarballs into a clean Bun consumer, typecheck with NodeNext, and run an ESM import smoke. It also asserts that the packages pack in dependency order, that internal version pins agree, that declared `bin` entries survive the pack, and that `frond-hub --version` runs through the installed `.bin` shebang. The packed payloads must include `src`, `README.md`, `package.json`, and — for everything but the hub — `dist`. They must not include `node_modules`, test output, local tarballs, or generated workspace artifacts outside the package payload.

## Versioning

1. Let release-please open the release PR from Conventional Commits.
2. Review the version bump, package changelogs, and `.release-please-manifest.json`.
3. Confirm `bun.lock` changed if package versions changed.
4. Run the full local verification again.
5. Merge the release PR to create GitHub Releases and tags.

`HUB_PROTOCOL_VERSION` in `packages/devtools/src/protocol.ts` is a second, independent axis and release-please does not touch it. Bump it in the same commit as any change to the attach wire — a field added to `AttachmentInfo`, a new member of `HubCommand`, a changed meaning for an existing one — because the two sides compare it for exact equality and an unbumped mismatch presents as a runtime that quietly stopped emitting. Leave it alone for everything else, including releases that move every package: bumping it refuses every app that has not upgraded, for a contract that did not change.

## Manual Publish

After the GitHub Releases and tags exist, publish from a local interactive terminal:

```sh
bun run publish:npm
```

The script reruns verification and package smoke before publishing `@frondruntime/core`, then `@frondruntime/react`, then `@frondruntime/devtools`, then `@frondruntime/hub`. That order is dependency order and is asserted, not conventional: each package's internal dependencies are already on the registry by the time it publishes. npm may prompt for a one-time password for each package.
