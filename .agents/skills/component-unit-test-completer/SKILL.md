---
name: component-unit-test-completer
description: >-
  Complete missing Cognia component tests and restore the Jest/RTL coverage
  gate. Use for component test gaps, RTL tests, test-to-source mapping, coverage
  regressions, or requests to raise component coverage; excludes vendored
  components/ui and components/ai-elements.
---

# Component Unit Test Completer

Use the repository's co-located Jest/RTL convention: map gaps, add behavioral
tests beside application components, then prove the 90% gate.

## Cognia test contract

Before testing, detect the project's test ecosystem:

- Runner: Jest 30 through `pnpm test`; components use React Testing Library and
  `@testing-library/user-event`.
- Tests are co-located as `Component.test.tsx`.
- New or edited application files under `components/**` require tests.
- `components/ui/**` and `components/ai-elements/**` are vendored and excluded;
  do not add tests there.
- Global line, statement, function, and branch coverage stays at least 90%.
- User-facing component strings use `next-intl`; tests should query localized
  accessible names through the repository's existing i18n mocks.

## Workflow

1. Discover component-to-test mapping gaps.
   - Run:
     ```bash
     rtk uv run --python 3.11 .agents/skills/component-unit-test-completer/scripts/component_test_map.py \
       --root components --exclude-dirs .git,.next,coverage,dist,node_modules,out,ui,ai-elements
     ```
   - Read the report and identify:
     - `missing`: component has no matched test file.
     - `duplicate`: one component has multiple matched tests; keep one canonical file and merge assertions.
     - `orphan_tests`: test file is not mapped by naming convention.

2. Create missing tests manually beside each component. The bundled generic
   scaffold is useful outside this repo, but it emits Vitest placeholders and
   is not a Cognia implementation path.

3. Complete tests component by component.
   - Follow one component -> one test file.
   - Cover at least:
     - happy-path render and primary interaction.
     - key branch states (loading/empty/error/disabled/permission).
     - callback emissions and prop-driven behavior.
     - accessibility-critical behavior (role/name/keyboard focus) when relevant.

4. Run the changed tests first: `rtk pnpm test -- <changed-test-files>`.

5. Enforce the 90% coverage gate.
   - Run:
     ```bash
     rtk pnpm test:coverage
     rtk uv run --python 3.11 .agents/skills/component-unit-test-completer/scripts/check_coverage_threshold.py --root . --threshold 90
     ```
   - If it fails, raise branch/function coverage first; line-only improvements are usually insufficient.

## Mapping Rules

- Treat a component as a file matching configured component extensions and not marked as test/story/declaration.
- Accept the co-located `<Component>.test.tsx` convention.
- Treat a second test file as a review signal; merge only when doing so preserves
  the intent of existing suites and does not touch unrelated user work.

## Guardrails

- Prefer existing project test stack (Vitest/Jest/RTL/Vue Test Utils) over introducing new frameworks.
- Keep assertions behavior-oriented; avoid snapshot-only suites unless repository already depends on snapshots.
- Avoid mock-heavy tests that hide component behavior; mock only unstable boundaries (network/time/random/browser-only APIs).
- Keep test names explicit so missing behavior is discoverable in CI.

## References

- Execution checklist: `references/unit-test-completion-checklist.md`
- Mapping checker script: `scripts/component_test_map.py`
- Coverage gate script: `scripts/check_coverage_threshold.py`
