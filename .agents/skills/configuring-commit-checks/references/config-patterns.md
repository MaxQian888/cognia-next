# Config Patterns

Apply the smallest compatible configuration that matches the repository's current stack.

## Node Repositories

### If `husky` already exists

- Check `.husky/` for `pre-commit`, `commit-msg`, or related hook files.
- Check `package.json` for:
  - quality scripts such as `lint`, `typecheck`, `test`, or `check`,
  - `lint-staged`,
  - `@commitlint/cli` or related config.
- Add only the missing pieces needed to wire the existing quality commands into the hook flow.

### If no hook tool exists

- Add `husky` as the primary hook runner.
- Add `lint-staged` for staged-file formatting and linting.
- Reuse existing package scripts instead of inventing parallel commands.

Minimal pattern:

```json
{
  "scripts": {
    "prepare": "husky"
  },
  "lint-staged": {
    "*.{js,ts,tsx,jsx}": ["eslint --fix", "prettier --write"]
  }
}
```

## Python Repositories

### If `pre-commit` already exists

- Extend `.pre-commit-config.yaml`.
- Prefer the repository's existing Python tools such as `ruff`, `black`, `pytest`, or `mypy`.
- Keep one entry point instead of adding `husky`.

### If no hook tool exists

- Add `.pre-commit-config.yaml`.
- Start with formatting and linting hooks that match the current toolchain.
- Add test-related hooks only when they are fast enough for commit-time use.

Minimal pattern:

```yaml
repos:
  - repo: https://github.com/astral-sh/ruff-pre-commit
    rev: v0.11.0
    hooks:
      - id: ruff-check
      - id: ruff-format
```

## Mixed Node And Python Repositories

- Prefer `pre-commit` as the top-level orchestrator when no hook tool exists.
- Reuse Python hooks directly in `.pre-commit-config.yaml`.
- Call Node commands through local package-manager commands instead of adding `husky` unless the repo already uses it.

Minimal pattern:

```yaml
repos:
  - repo: local
    hooks:
      - id: node-lint
        name: node-lint
        entry: npm run lint
        language: system
        pass_filenames: false
      - id: python-lint
        name: python-lint
        entry: ruff check .
        language: system
        pass_filenames: false
```

## Verification

- For `husky`: run the repository's install step and inspect the generated hook files.
- For `pre-commit`: run `pre-commit run --all-files` after the config is added or updated.
- For any stack: run the project-native commands invoked by the hooks and verify they pass.

## Anti-Patterns

- Replacing the repository's current hook framework without approval.
- Adding slow end-to-end suites to `pre-commit` by default.
- Creating new lint or test commands when suitable package scripts already exist.
- Claiming success without running the hook tool and the underlying project checks.
