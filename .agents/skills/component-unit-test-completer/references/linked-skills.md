# Linked Skills

Use this file when unit test completion reveals build issues, needs E2E follow-up, or is ready for commit.

## `$build-project-fixer`

Use when:

- tests fail due to build errors, type issues, or broken dependencies,
- the test runner command is unknown or fails.

## `$e2e-test-completer`

Use when:

- the user wants to verify user-facing flows after unit tests are complete,
- implementation changes may have affected E2E specs.

## `$commit-quality-fixer`

Use when:

- unit test work is complete and the user wants to commit.

## Routing Rules

- Prefer `$build-project-fixer` when the test runner fails or coverage thresholds are not met due to build issues.
- Prefer `$e2e-test-completer` when the user explicitly asks about end-to-end coverage.
- Do not keep placeholder scaffold assertions in the final result.
- Do not introduce a new test framework when the repo already has one.
