---
name: bun-workspace
description: Use when working with Bun package management, Bun workspaces, bun.lock, package scripts, Bun runtime APIs, Bun build commands, or Node/npm-to-Bun command translation in this repo.
---

# Bun Workspace

Use this skill for Bun runtime and workspace operations.

## Repo Facts

- Package manager: Bun.
- Workspace root: `package.json` with `workspaces: ["packages/*"]`.
- Lockfile: `bun.lock`; do not hand-edit it.
- Root scripts:
  - `bun run lint`
  - `bun run test`
  - `bun run typecheck`
  - `bun run effect:diagnostics`
  - `bun run effect:ls:check`
  - `bun run effect:ls:patch`
- Package-local scripts exist under `packages/*/package.json`.

## Root Scripts

- `bun run effect:diagnostics` - Effect language-service diagnostics for configured non-web packages.
- `bun run effect:ls:check` - check whether local TypeScript is patched for Effect diagnostics.
- `bun run effect:ls:patch` - patch local TypeScript so Effect diagnostics surface through build-time checks.
- `bun run lint` - Biome check.
- `bun run test` - Bun tests.
- `bun run typecheck` - TypeScript checks for the configured packages.

## Command Rules

- Read the relevant `package.json` before running scripts.
- Prefer existing scripts over raw binaries.
- Use `bun run <script>` for scripts.
- Use `bunx <tool>` only when no script exists and the tool is already an intended dev tool.
- Use `bun add`, `bun add -d`, and `bun remove` for dependency changes.
- Use workspace dependencies as `workspace:*` for local packages.
- Do not introduce npm, pnpm, yarn, or npx commands unless the user explicitly asks.

## Workspace Rules

- Run broad checks from the root when cross-package types or exports changed.
- Run package-local scripts when the change is isolated and the package has the script.
- Keep package exports aligned with source entrypoints.
- Do not edit generated `dist/` output unless the task explicitly requires build artifacts.
- If dependency installation or update is needed, expect `bun.lock` to change.

## Bun Runtime APIs

- Use Bun-native APIs when the package already targets Bun:
  - `Bun.file` / `Bun.write` for simple file IO.
  - `Bun.spawn` for subprocesses.
  - `bun:sqlite` for SQLite.
- Normalize Bun API failures at the boundary; do not leak raw foreign errors through domain code.
- Keep browser-safe packages free of Bun-only APIs.

## Verification

- Package manager or workspace changes: `bun install --frozen-lockfile` if checking lockfile integrity.
- Cross-package TypeScript changes: `bun run typecheck`.
- Script or runtime changes: run the relevant package script first, then root checks if the change crosses packages.
