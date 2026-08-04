---
title: ADR-0096 — Loading-state motion and accessibility
description: Tiering animation by essentiality, fixing the inverted speed preference, and giving loading regions a single voice.
---

## Status

Accepted — 2026-07-29.

## Context

The app had complete motion infrastructure (`MotionSettings`, `MotionApplier`,
`useFlowMotion`, motion tokens, `ChatThinkingIndicator`) and no contract
distinguishing **loading feedback** from **decoration**. Four defects followed
from that single omission.

**The reduce-motion guard froze every loading indicator.** `app/globals.css`
applies `animation-duration: 1ms; animation-iteration-count: 1` to `*` on three
paths (the `.reduce-motion` class, the `[data-reduce-motion="true"]` attribute,
and the `prefers-reduced-motion` media query). For decoration that is correct.
For `animate-spin` it meant one 1ms rotation and then a stop — 220 files' worth
of spinners rendered as static, broken-looking glyphs, and skeletons as inert
grey blocks. Users who asked for reduced motion lost every signal that the app
was still working. Nothing tested it.

**The animation-speed preference was inverted.** The settings UI labels its
options "Fast (1.5×)" and "Slow (0.5×)", but `resolveMotionState` wrote the
value straight into `--motion-duration-scale`, which consumers multiply by a
base duration: `calc(200ms * var(--motion-duration-scale))`. Choosing "Fast"
made every dialog, sheet, dock and panel transition 50% *slower*. The JS side
matched: `0.18 * speed` lengthened a fade for a faster preference, and
`damping: 30 / speed` lowered damping so a "Fast" spring oscillated longer.

**Accessibility was inverted at both ends.** `Skeleton` carried no ARIA at all
across ~174 call sites, while `Spinner` hard-coded `role="status"` plus an
English `aria-label="Loading"` — so its call sites, most of them buttons that
already announce their own state, fired a second untranslated live-region
update on every mount. (`components/ui/` is exempt from `lint:i18n`, which is
how the English string shipped.)

**Nothing guarded against flicker.** Reads in this app are Dexie-first and
usually settle inside a frame, so a skeleton rendered on `isLoading` appeared
and vanished within one paint.

## Decision

### 1. Three motion tiers

| Tier | Under reduced motion | Members |
| --- | --- | --- |
| Decorative | suppressed (unchanged) | shimmer sweep, avatar pulse, entrance reveals |
| Status | **keeps running**, speed-scaled | `.animate-spin`, `[data-slot="skeleton"]` |
| Vestibular | keeps signalling, **opacity only** | `.animate-bounce`, `.animate-ping` |

A small spinner is not a vestibular trigger, and removing it removes the only
evidence the app is alive. Translation and scaling are the parts actually
implicated in vestibular discomfort, so tier 3 keeps the signal and drops the
movement via a `motion-safe-fade-pulse` keyframe.

Implementation notes that are easy to get wrong:

- Exemptions must be repeated across **all three** guard paths. Missing the
  media query leaves OS-level reduced motion — the majority case — still frozen.
- Restoring `animation-duration` is not enough: the guard also pinned
  `animation-iteration-count: 1`, so both must come back.
- Specificity decides, not order. `html.reduce-motion *` scores (0,1,1);
  `html.reduce-motion .animate-spin` scores (0,2,1). Both are `!important`.
- Durations route through `--motion-duration-scale`; Tailwind's `animate-*`
  utilities hard-code their timing and would otherwise ignore the preference.

**`data-slot="skeleton"` is load-bearing.** It is the only hook the tier has,
and only `components/ui/skeleton.tsx` emits it. A hand-rolled
`bg-muted animate-pulse` block is invisible to the tier and freezes.

### 2. Speed and duration are reciprocals

`MotionSettings.speed` stays the user-facing *speed* multiplier.
`speedToDurationScale` (in `lib/appearance/motion-applier.tsx`) inverts it once,
at the single writer. Every CSS `calc()` consumer and the plugin SDK's
`durationScale` token became correct with no edit. `useFlowMotion` now exposes
only `durationScale` — the two were conflated at every call site, which is what
let the same inversion spread across 13 of them.

### 3. The region announces; the graphics do not

`Skeleton` is `aria-hidden` by default. `Spinner` is decorative unless given a
`label`. `LoadingRegion` (`components/ui/loading-region.tsx`) owns `aria-busy`
plus one polite `role="status"` message for the whole area, re-announcing only
when a wait escalates or the device turns out to be offline.

### 4. Anti-flicker lives in a hook, not the primitives

`useDeferredLoading` gates on 180ms before showing and 320ms minimum display.
It is a hook because whether a wait is worth showing is knowledge the **data
layer** has (a warm Dexie hit versus a cold network pull), not something a
presentational primitive can infer — and keeping the primitives synchronous
leaves the ~30 existing suites that assert a skeleton renders immediately valid.

Thresholds are **not** scaled by `--motion-duration-scale`: they are perception
thresholds, not animation. A user who prefers slower animation has not asked to
be shown more skeletons.

## Consequences

**A frozen spinner is now a bug, not the policy.** If someone "fixes" the
exemption block because it looks like it defeats reduced motion, they will
reintroduce the original defect. That is the single most important thing this
document exists to prevent.

**Enforcement.** `pnpm audit:loading-states` fails when a new or renamed file
hand-rolls a spinner or a skeleton. Its baseline records the deliberate
non-migrations and may only shrink. The gate distinguishes a placeholder from a
pulsing *running-state dot* — the latter is not a skeleton and rewriting it as
one would be a bug.

**Deliberate non-scope.** `components/settings/**` (116 files) and ~100
button-only spinner sites were not migrated: they inherit the correctness fixes
through the shared CSS and primitives without an edit, and touching them would
have dragged 200+ files through the 90% changed-file coverage gate for a
cosmetic win.

**Determinate progress is still missing** for ~~plugin activation (10–45s),~~
data import's `applying` phase, workflow step counts, and Agent Team
orchestration. The information exists; surfacing it needs changes to those
state-reporting chains and is out of scope here. (Plugin activation was
delivered 2026-08-03 — see the amendment below.)

---

## Amendment — 2026-08-03 (determinate plugin activation)

Closes the plugin-activation half of the gap recorded above. The other
three surfaces still have no determinate progress.

### Added: a seven-phase model where monotonicity is structural

`preflight → dependencies → schema → runtime → contributions → hooks →
commit`, with `processedForPhase(phase)` returning the phase's **index
and nothing else**.

That one decision is what makes the two hard properties fall out for
free rather than needing to be maintained:

- **Monotonic** — `processed` is a function of the phase name, never of
  work actually completed, so it cannot go backwards.
- **Skipped optional work still advances** — a plugin with no
  `manifest.dexie` and no dependencies still *enters* the `schema` and
  `dependencies` phases and still reports 2/7 and 1/7.

The corresponding rule for `lib/plugin/core/manager.ts`: **no `advance`
call may sit inside a conditional.** A regression test runs a manifest
with no Dexie tables and no dependencies and asserts it produces a phase
sequence identical to a fully-loaded one — that is what catches an
`advance` that someone later moved inside an `if`.

Dependency sub-activations need no bookkeeping at all: the recursion
goes through the same wrapper, so each dependency gets its own entry
running 0/7 → 7/7 while the parent stays frozen at `dependencies` 1/7
until the loop returns. A property of the call graph, not of state
management.

### Ruling: rollback ordering, and why there is no `finally`

`enablePluginInner`'s own catch runs the entire rollback —
unregister contributions, set the plugin error, emit
`PLUGIN_ENABLE_FAILED_EVENT` — *before* rethrowing to the outer catch
that records the failure. So during rollback the entry is still
`running` at the failing phase, which is correct: the work is not
finished. `fail` then runs strictly after every rollback side effect,
including the toast.

Using `finally` on the inner try would fire before the rethrow reached
the outer catch and invert that order. The instrumentation comments say
so at the edit site, because the shape looks like an oversight.

### Added: `LoadingRegion` gains a determinate variant

`progress?: { processed, total, phaseLabel? } | null`, additive.

- The sr-only `role="status"` text becomes `"<base> — <phase> —
  <n>/<total>"`, which changes at most seven times per activation —
  exactly the re-announce cadence this ADR designs for.
- The visible `<Progress>` renders as a **sibling of, never a child of**
  the status span, so Radix's implicit `role="progressbar"` sits outside
  the live region and value updates are not announced.
- `progress` is **ignored when `total <= 0`**, falling back to
  indeterminate. A determinate 0% bar is a claim; a spinner is the truth.
- **No `onCancel`.** `enablePlugin` has no cancellation token, and this
  ADR says to offer cancel only when it genuinely stops the work.

### Fixed: `Progress` published no `aria-valuenow`

`components/ui/progress.tsx` destructured `value` and used it only for
the CSS transform, never forwarding it to `ProgressPrimitive.Root`. Every
progress bar in the app was visually determinate and accessibly
indeterminate. One line; the determinate-accessibility contract above
depended on it.

### Fixed: `/plugins` toggles never activated anything

All four toggle sites wrote only the Dexie `enabled` flag, and no
reconciler subscribes to it — `manager.enablePlugin` was reachable from
boot restore, the updater, and remote control, but never from the panel.
They now route through the manager, with the Dexie write as a
*consequence* of the transition rather than a substitute for it, and
revert the optimistic toggle on failure.

This also revives the previously-dead `PluginStatusPill` `loading`
branch: no code path wrote `enabling`/`loading` to the Dexie row, so the
`isLoading` derivation never fired from the panel. The batch bar's
`Promise.all` became a sequential loop — parallel activation of plugins
with interdependencies is not something the manager's lifecycle lock
makes safe to assume.

**Unverified.** The reduce-motion contract has unit coverage only. jsdom does
not run animations, so a real-browser check is still owed; a first attempt found
that the app reports `prefers-reduced-motion: false` under Playwright's
emulation even though the same emulation works on `about:blank`, which needs its
own investigation before a spec can be trusted.
