---
name: configuring-commit-checks
description: >-
  Configure or repair Cognia commit checks. Use for Husky, lint-staged,
  commitlint, pre-commit hooks, commit gates, or checks that fail before a
  commit; preserves the repository's existing pnpm + Husky 9 stack.
---

# Configuring Commit Checks

Preserve the existing stack: Husky 9 is the hook runner, lint-staged formats and
lints staged files, and commitlint enforces Conventional Commits.

## Current wiring

Before configuring, detect the repository's existing setup and project type:

- `.husky/pre-commit` runs lint-staged, then `lint:i18n:staged`.
- `.husky/commit-msg` runs commitlint against the message file.
- `package.json#lint-staged` owns file-pattern commands.
- `commitlint.config.*` owns message rules.
- `prepare: husky` installs hooks after `pnpm install`.

## Workflow

1. **Inspect the live setup.**

   ```bash
   rtk uv run --python 3.11 .agents/skills/configuring-commit-checks/scripts/detect_commit_setup.py --project-root . --json
   ```

   If the current directory is nested inside a monorepo or workspace, trust the script's `detected_root` instead of guessing.

2. **Trace the failing seam.** Reproduce the hook command directly before
   changing configuration. A lint failure is a source failure until proven
   otherwise; a missing executable or hook file is configuration.
3. **Make the smallest compatible change.** Extend the existing Husky file,
   lint-staged map, or commitlint config. Adding another hook framework is a
   migration and requires an explicit user request.
4. **Keep shared-tree safety.** lint-staged may create a temporary stash. Do
   not invoke the real commit hook while other sessions have unrelated staged
   work; run the underlying commands directly against the intended files.
5. **Verify.** Run `rtk pnpm exec husky`, the exact hook commands, and a
   representative commit message through `rtk pnpm exec commitlint`.

## Guardrails

- **Do not swap frameworks casually.** Replacing `pre-commit` with `husky` (or vice versa) is a migration, not a quick fix. Only do it when the user explicitly asks.
- **Do not add competing systems.** If one framework already governs commits successfully, don't layer another on top.
- **Do not assume the working directory is the repository root.** Monorepos and nested apps are common.
- **Do not weaken rules to make hooks pass.** If a lint or test is too strict, fix the code or adjust the rule at the project level — not inside the hook.
- **Do not invent a generic stack when a local convention already exists.** Every team has its own habits; honor them.

## References

- Selection rules for an explicitly requested migration:
  `references/selection-matrix.md`
- Generic completion patterns for repairing missing files:
  `references/config-patterns.md`
- Detection helper: `scripts/detect_commit_setup.py`
