---
name: component-unit-test-completer
description: >
  Make sure to use this skill whenever the user wants to add missing component
  tests, complete unit test coverage, enforce one-to-one component/test mapping,
  or set up test coverage gates. Also trigger when they mention "write tests for
  my components," "increase test coverage," "missing component tests," "test
  coverage is too low," "add RTL tests," or "set up Vitest/Jest coverage."
  Covers synonyms like "unit test completion," "test gap analysis," "coverage
  enforcement," "component testing," "test scaffolding," and "UI test audit."
  Use it even when the user only says "I need tests" or "my components aren't
  tested" without specifying the framework.
---

# Component Unit Test Completer

When completing component unit tests, enforce one-to-one component/test mapping first, then fill behavior assertions, then enforce the coverage threshold gate.

## Adaptive Detection

Before testing, detect the project's test ecosystem:

- Check `package.json` for test frameworks: Vitest, Jest, Cypress, Playwright.
- Detect testing libraries: React Testing Library, Vue Test Utils, Enzyme.
- Check for existing coverage configuration: `vitest.config.ts`, `jest.config.js`, `.nycrc`.
- Identify component file extensions: `.tsx`, `.jsx`, `.vue`, `.svelte`.
- Detect test file conventions: co-located, `__tests__`, or mirrored `tests/` directory.
- Check for existing CI coverage gates in `.github/workflows/`.

## Workflow

1. Discover component-to-test mapping gaps.
   - Run:
     ```bash
     uv run --python 3.11 scripts/component_test_map.py --root .
     ```
   - Read the report and identify:
     - `missing`: component has no matched test file.
     - `duplicate`: one component has multiple matched tests; keep one canonical file and merge assertions.
     - `orphan_tests`: test file is not mapped by naming convention.

2. Scaffold missing test files only when it saves time.
   - Run:
     ```bash
     uv run --python 3.11 scripts/component_test_map.py --root . --scaffold-missing
     ```
   - Replace scaffold TODOs with real tests immediately; do not keep placeholder assertions in final result.

3. Complete tests component by component.
   - Follow one component -> one test file.
   - Cover at least:
     - happy-path render and primary interaction.
     - key branch states (loading/empty/error/disabled/permission).
     - callback emissions and prop-driven behavior.
     - accessibility-critical behavior (role/name/keyboard focus) when relevant.

4. Run project tests with coverage enabled.
   - Common examples:
     ```bash
     npm test -- --coverage
     ```
     ```bash
     pnpm test --coverage
     ```
     ```bash
     vitest run --coverage
     ```

5. Enforce 80%+ coverage gate.
   - Run:
     ```bash
     uv run --python 3.11 scripts/check_coverage_threshold.py --root . --threshold 80
     ```
   - If it fails, raise branch/function coverage first; line-only improvements are usually insufficient.

## Mapping Rules

- Treat a component as a file matching configured component extensions and not marked as test/story/declaration.
- Accept test files by convention:
  - Co-located: `<Component>.test.*` or `<Component>.spec.*`
  - Sibling test dir: `__tests__/<Component>.test.*` or `__tests__/<Component>.spec.*`
  - Root tests mirror: `tests/<same-relative-path>/<Component>.test.*` or `.spec.*`
- Require exactly one canonical test file per component for final state.
- Resolve duplicates by merging assertions and deleting extra test entry points.

## Guardrails

- Prefer existing project test stack (Vitest/Jest/RTL/Vue Test Utils) over introducing new frameworks.
- Keep assertions behavior-oriented; avoid snapshot-only suites unless repository already depends on snapshots.
- Avoid mock-heavy tests that hide component behavior; mock only unstable boundaries (network/time/random/browser-only APIs).
- Keep test names explicit so missing behavior is discoverable in CI.

## Examples

**Discover missing tests:**

```bash
uv run --python 3.11 scripts/component_test_map.py --root .
```

**Scaffold and check coverage:**

```bash
uv run --python 3.11 scripts/component_test_map.py --root . --scaffold-missing
vitest run --coverage
uv run --python 3.11 scripts/check_coverage_threshold.py --root . --threshold 80
```

## References

- Execution checklist: `references/unit-test-completion-checklist.md`
- Mapping checker script: `scripts/component_test_map.py`
- Coverage gate script: `scripts/check_coverage_threshold.py`
