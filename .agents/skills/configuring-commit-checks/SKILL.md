---
name: configuring-commit-checks
description: >
  Make sure to use this skill whenever the user wants to set up, configure, or
  repair commit hooks, pre-commit checks, git hooks, husky, lint-staged,
  lefthook, or commitlint. Also trigger when they mention "run checks before
  commits," "add pre-commit hooks," "fix my git hooks," "set up lint-staged,"
  or "configure commit checks." Covers synonyms like "hook setup," "pre-commit
  configuration," "commit gate," "quality checks on commit," "git hook repair,"
  and "lint before push." Use it even when the user only says "I want checks
  to run before I commit" or "help me set up git hooks" without naming a
  specific tool.
---

# Configuring Commit Checks

Look before you change. Inspect the repository's existing commit-hook setup before adding or modifying anything. Respect the current toolchain when one is already in place. Only introduce a default stack when the project genuinely has no commit-check tooling at all.

## Adaptive Detection

Before configuring, detect the repository's existing setup and project type:

- Check for existing hook tools: `.husky/`, `.pre-commit-config.yaml`, `lefthook.yml`.
- Detect project type from files: `package.json` (Node), `pyproject.toml` (Python), `Cargo.toml` (Rust), `go.mod` (Go).
- Check for existing lint/format/test tools in `package.json` scripts or `pyproject.toml`.
- Detect package manager: pnpm, yarn, bun, npm, uv, poetry, pipenv.
- Identify monorepo or workspace structure to find the real repository root.

## Workflow

1. **Find the real repository root.**

   ```bash
   uv run --python 3.11 scripts/detect_commit_setup.py --project-root . --json
   ```

   If the current directory is nested inside a monorepo or workspace, trust the script's `detected_root` instead of guessing.

2. **Read the recommendation.**
   The script returns one of four strategies:
   - `preserve-existing` — keep the current primary tool and add only what's missing.
   - `complete-existing` — finish a partial stack (for example, lint-staged without a hook runner).
   - `add-default` — add the standard stack for the detected project type.
   - `review-manually` — stop and inspect the repo rather than guessing.

3. **Apply defaults only when nothing exists.**
   - Node-only project → `husky` + `lint-staged`.
   - Python-only project → `pre-commit`.
   - Mixed Node + Python → `pre-commit` as the top-level orchestrator.

4. **Make the smallest compatible change.**
   - Already uses `husky`? Extend `.husky/` and related package config.
   - Already uses `pre-commit`? Extend `.pre-commit-config.yaml`.
   - Already uses `lefthook`? Keep `lefthook.yml` as the entry point.

5. **Verify before you call it done.**
   Run the hook tool's install or validation command. Then run the project-native lint, format, typecheck, or test commands the hook will actually call. Do not claim the setup is complete without fresh verification output.

## Guardrails

- **Do not swap frameworks casually.** Replacing `pre-commit` with `husky` (or vice versa) is a migration, not a quick fix. Only do it when the user explicitly asks.
- **Do not add competing systems.** If one framework already governs commits successfully, don't layer another on top.
- **Do not assume the working directory is the repository root.** Monorepos and nested apps are common.
- **Do not weaken rules to make hooks pass.** If a lint or test is too strict, fix the code or adjust the rule at the project level — not inside the hook.
- **Do not invent a generic stack when a local convention already exists.** Every team has its own habits; honor them.

## Examples

**Detect and configure a fresh Node project:**

```bash
uv run --python 3.11 scripts/detect_commit_setup.py --project-root . --json
```

Then apply the `add-default` strategy (husky + lint-staged).

**Extend existing pre-commit with mypy:**

```bash
uv run --python 3.11 scripts/detect_commit_setup.py --project-root . --json
```

Then use the `preserve-existing` strategy to add a mypy hook.

## References

- Selection rules and defaults: `references/selection-matrix.md`
- Minimal completion patterns: `references/config-patterns.md`
- Detection helper: `scripts/detect_commit_setup.py`
