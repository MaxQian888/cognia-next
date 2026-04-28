# Selection Matrix

Use this matrix after running `scripts/detect_commit_setup.py`.

| Repository shape    | Existing tool found | Recommendation              | Why                                                                                                    |
| ------------------- | ------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------ |
| Node-only           | `husky`             | Preserve `husky`            | Keep the existing hook entry point and add only missing support such as `lint-staged` or `commitlint`. |
| Node-only           | `pre-commit`        | Preserve `pre-commit`       | The repository already chose a top-level orchestrator; do not migrate to `husky` unless asked.         |
| Node-only           | `lefthook`          | Preserve `lefthook`         | Existing hooks should stay on the chosen tool.                                                         |
| Node-only           | none                | Add `husky` + `lint-staged` | This is the best default for a JavaScript or TypeScript repo with no hook system.                      |
| Python-only         | `pre-commit`        | Preserve `pre-commit`       | It is the natural default for Python repositories and should be extended, not replaced.                |
| Python-only         | `lefthook`          | Preserve `lefthook`         | Existing tooling takes precedence over preference.                                                     |
| Python-only         | none                | Add `pre-commit`            | One top-level config is the simplest and most conventional default.                                    |
| Mixed Node + Python | `pre-commit`        | Preserve `pre-commit`       | One orchestrator is ideal for multi-language repositories.                                             |
| Mixed Node + Python | `husky`             | Preserve `husky`            | The repository already standardized on a hook runner; extend it instead of layering another framework. |
| Mixed Node + Python | `lefthook`          | Preserve `lefthook`         | Existing multi-language hook tooling should stay in place.                                             |
| Mixed Node + Python | none                | Add `pre-commit`            | It can orchestrate both Python and Node commands without adding multiple competing systems.            |
| Unknown             | anything            | Preserve existing           | Existing evidence is safer than inventing a new stack.                                                 |
| Unknown             | none                | Review manually             | Do not guess when the project type is unclear.                                                         |

## Supporting Tools

- `lint-staged` is a supporting tool, not a primary hook runner.
- `commitlint` is a supporting tool, not a replacement for `husky`, `pre-commit`, or `lefthook`.
- If only supporting tools are present, complete the likely stack instead of declaring the repo fully configured.

## Red Flags

- Replacing a working hook system just to match a personal preference.
- Adding both `husky` and `pre-commit` to a repository that already has one clear entry point.
- Treating a nested sample app as the real repository root.
