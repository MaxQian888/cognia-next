---
name: jest-gotchas
description: Repo-specific Jest/RTL/eslint traps for cognia-next, each with the working pattern. Use before writing or fixing any test in this repo, and when hitting TDZ errors in jest.mock factories, failing spyOn, TS2556, Radix interaction failures, or set-state-in-effect lint blocks.
---

# Jest / RTL / ESLint Gotchas (cognia-next)

Every entry below cost a debugging round. Check this list BEFORE writing
tests, and again when a test fails for a non-obvious reason.

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

7. **set-state-in-effect** — synchronous `setState` inside `useEffect` is
   blocked by the local eslint config (and runs in lint-staged on commit).
   Prefer derived state during render; deriving selection from props beats
   set-state-in-effect (established pattern in the skills page).
8. **no-Date.now / ref-write / inner-component-in-render** are also enforced
   — inject clocks, don't write refs during render, hoist nested component
   definitions.

## Runner traps

9. **`pnpm test -- --coverage` treats flags as test-name patterns** (runs
   nothing useful). Coverage is `pnpm test:coverage` only.
10. **Single file**: `pnpm test -- path/to/file.test.ts`. Narrow first; the
    full suite is the final gate.
11. **Stale background tsc** — a long-running `tsc --watch`/background check
    can report errors from a previous tree state; re-run `rtk tsc` fresh
    before trusting failures you didn't cause.
12. **Coverage exemptions**: pure type-only modules go in the
    `collectCoverageFrom` exclusion list in `jest.config.ts` (V8 reports 0%
    for them). A new type-only file must either be excluded there or get a
    surface test, or the gate drops.
