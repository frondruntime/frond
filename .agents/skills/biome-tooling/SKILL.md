---
name: biome-tooling
description: Use when running, interpreting, or modifying Biome linting/formatting/import organization in this repo, including biome.json, Grit plugins, formatting fixes, and lint failures.
---

# Biome Tooling

Use this skill for Biome formatting and linting.

## Repo Facts

- Biome is configured locally; inspect `package.json` / lockfile for the installed version when version-specific behavior matters.
- Root command: `bun run lint` -> `bunx biome check`.
- Config: `biome.json`.
- Biome organizes imports through assist source actions.
- Custom Grit plugins block stale Effect v3 patterns and several local style hazards.
- For custom Grit plugin authoring or diagnostic-message design, use `biome-grit-rules`.

## Command Rules

- Use `bun run lint` for the repo check.
- For a focused check, use `bunx biome check <path>` only after confirming no script already covers the need.
- Use write mode only when the user asked for fixes or formatting is part of the task.
- Do not debate formatting output; accept Biome as the formatter.
- Do not use Prettier or ESLint unless the user explicitly asks.

## Config Rules

- Read `biome.json` before changing lint or formatting behavior.
- Keep generated outputs, lockfiles, `node_modules`, `dist`, and build artifacts excluded unless there is a deliberate reason.
- Treat custom Grit plugin failures as repo policy, not generic style suggestions.
- If a rule is noisy, fix the code first; weaken config only when the rule is wrong for the repo.
- Repeated implementation mistakes should become deterministic checks when the bad pattern is syntactically recognizable and low-noise.

## Common Fix Strategy

1. Run or inspect the focused Biome failure.
2. Identify whether it is formatting, import organization, lint, or Grit plugin policy.
3. Apply the smallest source fix.
4. Re-run the focused check or `bun run lint`.

## Anti-Patterns

- Do not hand-format large files instead of running Biome when write mode is appropriate.
- Do not add inline ignores without a reason tied to runtime behavior or type-system limits.
- Do not change `biome.json` to make one local warning disappear.
- Do not edit `dist/` just to satisfy Biome.
