# Release Checklist

Use this checklist before publishing `@frondruntime/core` and `@frondruntime/react`.

## Policy

- Publish only from `master` after CI is green.
- Keep `@frondruntime/core` and `@frondruntime/react` on the same version unless a release explicitly documents why only one package changes.
- Keep `packages/react/package.json` peer dependency on `@frondruntime/core` aligned to the release version.
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

`@frondruntime/core` and `@frondruntime/react` use linked versions. Release-please tracks both packages in `.release-please-manifest.json`, updates workspace peer dependencies through the `node-workspace` plugin, and emits component tags instead of one shared tag.

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

The rehearsal must build, run `npm publish --dry-run` where possible, pack both packages, install the packed tarballs into a clean Bun consumer, typecheck with NodeNext, and run an ESM import smoke. The packed payloads must include `dist`, `src`, `README.md`, and `package.json` for each package. They must not include `node_modules`, test output, local tarballs, or generated workspace artifacts outside the package payload.

## Versioning

1. Let release-please open the release PR from Conventional Commits.
2. Review the version bump, package changelogs, and `.release-please-manifest.json`.
3. Confirm `bun.lock` changed if package versions changed.
4. Run the full local verification again.
5. Merge the release PR to create GitHub Releases and tags.

## Manual Publish

After the GitHub Releases and tags exist, publish from a local interactive terminal:

```sh
bun run publish:npm
```

The script reruns verification and package smoke before publishing `@frondruntime/core`, then `@frondruntime/react`. npm may prompt for a one-time password for each package.
