# Unit Test Completion Checklist

Use this checklist when closing a component unit test completion task.

## 1. Mapping completeness

- Run `uv run --python 3.11 scripts/component_test_map.py --root .`.
- Confirm `missing: 0`.
- Confirm `duplicates: 0`.
- If `orphan_tests > 0`, decide whether each orphan is acceptable (integration/e2e/helper) or should be renamed/removed.

## 2. One component, one canonical test

- Keep exactly one canonical unit-test entry file for each component.
- Merge assertions from duplicate files into the canonical file.
- Preserve naming consistency with repository conventions (`.test` or `.spec`).

## 3. Assertion quality

- Include at least one happy-path assertion per component.
- Cover meaningful branches: loading, empty, error, disabled, permission, or state toggles.
- Assert user-visible behavior and callback effects rather than implementation details.
- Include accessibility-critical checks when component behavior depends on roles/labels/focus.

## 4. Coverage gate

- Run project tests with coverage enabled.
- Run `uv run --python 3.11 scripts/check_coverage_threshold.py --root . --threshold 80`.
- Treat any failed metric as release-blocking for this skill's workflow.

## 5. Final acceptance

- Mapping report passes.
- Coverage gate passes.
- New/updated tests are deterministic and do not rely on unstable timing/network state.
