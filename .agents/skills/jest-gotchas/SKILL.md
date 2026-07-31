---
name: jest-gotchas
description: Diagnose Cognia-specific Jest, RTL, and test-lint failures. Use when writing or fixing tests, especially for jest.mock TDZ behavior, ESM namespace spies, strict jest.fn types, Radix interactions, hidden content, ESM dependencies, or coverage collection.
---

# Jest / RTL / ESLint Gotchas (cognia-next)

Use the narrowest applicable pattern, then prove it with the changed test file.

## jest.mock traps

1. **Factory TDZ** — variables referenced inside a `jest.mock(path, factory)`
   factory hit the temporal dead zone even with the `mock` prefix. Define
   `jest.fn()`s INSIDE the factory, then re-import to grab references:

   ```ts
   jest.mock("@/lib/x", () => ({ doThing: jest.fn() }))
   import { doThing } from "@/lib/x"
   const doThingMock = doThing as jest.Mock
   ```

2. **`jest.spyOn` on a namespace import fails** (e.g. spying `isTauri` on
   `@/lib/tauri`, or any `import * as ns`) — ESM namespace objects are
   read-only. Use a partial module mock instead:

   ```ts
   jest.mock("@/lib/tauri", () => ({
     ...jest.requireActual("@/lib/tauri"),
     isTauri: jest.fn(() => true),
   }))
   ```

3. **`jest.fn()` zero-arg + strict TS → TS2556** when later called with
   spread args. Type it at creation: `jest.fn<Ret, [ArgA, ArgB]>()` or
   `jest.fn((a: ArgA) => ret)`.

## RTL / component traps

4. **Radix-based components need `userEvent`** — `fireEvent.click` does not
   open Radix dropdowns/selects/popovers (pointer-event detail checks). Use
   `const user = userEvent.setup()` + `await user.click(...)`.
5. **Query by accessible role/name**, not test IDs — and note
   react-resizable-panels v4 overrides `data-testid` on `Panel` with `id`.
6. **Collapsible closed = mounted but hidden** — closed Radix Collapsible
   content is in the DOM; assert visibility (`not.toBeVisible()` /
   `queryByRole` with `hidden`), not absence.

## ESLint rules that block common test/impl patterns

7. **React compiler lint** — outside vendored `components/ui/` and
   `components/ai-elements/`, prefer render-derived state, inject clocks, write
   refs in effects/handlers, and hoist nested components. The vendored paths
   have explicit relaxations in `eslint.config.mjs`; application code does not.

## Runner traps

8. **`pnpm test -- --coverage` treats flags as test-name patterns** (runs
   nothing useful). Coverage is `pnpm test:coverage` only.
9. **Single file**: `rtk pnpm test -- path/to/file.test.ts`. Narrow first; the
    full suite is the final gate.
10. **Stale background tsc** — a long-running `tsc --watch`/background check
    can report errors from a previous tree state; re-run `rtk pnpm typecheck`
    before trusting failures you didn't cause.
11. **ESM dependency parse errors** — add only the failing package to the
    pnpm-aware negative lookahead in `jest.config.ts#transformIgnorePatterns`;
    copy the existing scoped-package forms instead of replacing the pattern.
12. **Coverage exemptions** — exclude a genuinely type-only barrel beside the
    existing `collectCoverageFrom` exceptions in `jest.config.ts`; runtime
    constants or guards still require tests.
