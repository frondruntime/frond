---
name: biome-grit-rules
description: Use when creating, reviewing, or modifying custom Biome Grit plugins in undefined*.grit, especially deterministic agent-correction rules for stale Effect v3 patterns, local style hazards, and diagnostic messages that tell agents what to do next.
---

# Biome Grit Rules

Use this skill for repo custom lint rules under `undefined*.grit`.

## Purpose

Custom rules turn repeated implementation mistakes into deterministic feedback. In this repo, Effect v3 patterns are a primary target because they are common in generated code while Frond uses Effect v4 beta patterns.

## Before Adding A Rule

Add or tighten a rule only when:

- the bad pattern is syntactically recognizable
- the desired replacement is deterministic or clearly explainable
- false positives are low
- the pattern has appeared more than once, is high-risk, or reflects stale API training data
- the rule can produce a useful diagnostic at the exact bad span

Propose first instead of editing when the rule could affect many files or needs semantic judgment.

## Diagnostic Messages

Every diagnostic message should act as a small prompt:

- name the repo rule or API generation, such as `Effect v4`
- say what is wrong
- say what to do instead
- mention the relevant skill when the mistake implies a stale mental model

Example shape:

```text
Effect v4: Effect.catchAll was renamed to Effect.catch. Use Effect.catch for all typed errors, Effect.catchTag/Effect.catchTags for specific tags, or Effect.catchCause for cause-level handling. Load skill: effect-v4.
```

Do not hard-code exact dependency versions unless the version itself is the rule.

## Severity

- Use `error` for stale APIs, known unsafe patterns, and hard repo invariants.
- Use `warning` for style guidance or patterns with legitimate exceptions.
- Avoid broad rules that force taste when the repo does not have a stable invariant.

## Verification

After changing a rule:

1. Run `bunx biome check <target>` against a file that should trigger or currently triggered the rule.
2. Confirm the diagnostic span and message are clear.
3. Run the focused check against at least one nearby clean file when false positives are plausible.
4. Run `bun run lint` when the rule is broad or touches shared config.

## Maintenance

- Keep plugin filenames specific and negative: `no-effect-v3-catchall.grit`.
- Keep messages short enough to read in terminal output.
- Prefer rules that remove a whole class of future fixes.
- If a rule fires too broadly, narrow the pattern before lowering severity.
