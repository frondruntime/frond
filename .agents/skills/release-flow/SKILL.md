---
name: release-flow
description: Use when creating commits, pull requests, release PRs, version bumps, npm publish dry-runs, package tarball smoke tests, or release notes for frondruntime.
---

# Release Flow

Use this skill whenever work may be committed, merged, released, packed, or published.

## Commit Messages

Release automation reads Conventional Commit messages from merged history. In normal GitHub squash flow, the squash commit title is the release signal.

- `fix:` means SemVer patch.
- `feat:` means SemVer minor.
- `type!:` or a `BREAKING CHANGE:` footer means SemVer major.
- `docs:`, `test:`, `chore:`, `refactor:`, `build:`, and `ci:` should not be used for package behavior changes that need a release note.
- Do not use `fix:` or `feat:` for housekeeping that should not publish.
- Prefer scopes when they clarify ownership: `core`, `react`, `build`, `ci`, `docs`, `release`.
- Write the subject in imperative present tense and keep it specific.

Examples:

- `fix(core): roll up published declarations`
- `feat(react): add preload boundary controls`
- `build: simplify package smoke script`
- `docs: document npm publish checklist`

## Pull Requests

- Make the PR title the intended squash commit title.
- Use draft PRs for agent-created branches unless the user explicitly asks for ready-for-review.
- Include a `Release impact` section: `none`, `patch`, `minor`, or `major`.
- If release impact is not `none`, describe the user-visible change in release-note language.
- Include validation commands and package smoke results.
- State known boundaries directly, especially peer dependency or `skipLibCheck` requirements.
- Do not assume npm publication. Release-please can create version/changelog/tag/GitHub release artifacts; npm publish is separate unless a workflow explicitly performs it.

## Package Publish Rehearsal

Before a public npm publish or release PR merge that changes package output:

Run `bun run publish:npm:dry-run`. It performs the full publish rehearsal:

1. Run `bun install --frozen-lockfile`.
2. Run `bun run lint`.
3. Run `bun run typecheck`.
4. Run `bun run effect:diagnostics`.
5. Run `bun run test`.
6. Run `bun run build`.
7. Check whether each exact package version already exists on npm. If it does and this is only a rehearsal, skip `npm publish --dry-run` for that already-published version and continue to tarball smoke. If the version does not exist, run `npm publish --dry-run --access public`.
8. Run `npm pack` for each package into a temporary directory.
9. Create a clean temporary Bun consumer that installs the packed `.tgz` files using `file:` dependencies.
10. Typecheck that consumer with `moduleResolution: NodeNext`.
11. Run a Node ESM import smoke for every public export path.

For the actual npm publish, run `bun run publish:npm`. The script runs the same checks and smoke first, then calls `npm publish --access public` for each package. npm will prompt for a one-time password when account or organization 2FA requires it.

Publish and release scripts in this repo must use Effect for orchestration. Keep subprocesses, filesystem writes, temp cleanup, tarball checks, and publish steps as `Effect` values with typed failures. Use `Effect.gen` for sequencing, `Effect.forEach` / `Effect.all` for ordered or parallel work, and `Effect.ensuring` for cleanup. Keep `Effect.runPromise` only at the top-level process boundary.

Expected package export paths:

- `@frondruntime/core` -> `dist/index.js`, `dist/index.d.ts`
- `@frondruntime/core/testing` -> `dist/testing/index.js`, `dist/testing/index.d.ts`
- `@frondruntime/react` -> `dist/index.js`, `dist/index.d.ts`
- `@frondruntime/react/testing` -> `dist/testing/index.js`, `dist/testing/index.d.ts`

## Versioning

- Do not republish an existing npm version. npm rejects it and package versions are immutable.
- `npm publish --dry-run` still consults the registry and fails for an already-published exact version. That is expected after a version has shipped; use the tarball smoke result as the rehearsal signal until release-please bumps the next version.
- If `0.0.1` already exists, the next patch release is `0.0.2`.
- Prefer letting release-please create version and changelog changes after merge.
- Do not hand-bump versions unless the user explicitly chooses a manual release path.

## Safety

- Never commit or push without explicit approval.
- Stage release-flow changes explicitly; do not include `dist`, tarballs, temporary smoke apps, or unrelated workspace changes.
- Do not place private docs, internal apps, or archived material into the public package release surface.
