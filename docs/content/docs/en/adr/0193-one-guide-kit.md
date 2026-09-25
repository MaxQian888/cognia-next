---
title: "0193 — One guide kit, and setup gaps read live"
description: "The first-run flow, the pairing flow and the in-app setup reminders were three hand-built looks for one kind of thing. They now render one guide kit under components/guide/. What setup still needs is re-derived from live state instead of printed from the recorded exit path, and each reminder goes straight to the one step that closes its gap."
---

# ADR 0193 — One guide kit, and setup gaps read live

**Status:** Accepted — Implemented
**Date:** 2026-09-25
**Amends:** [ADR-0122](./0122-first-run-onboarding) (decision 13, the finish-setup bar), [ADR-0141](./0141-onboarding-two-paths) (narrative panel, recommended path)

## Context

Cognia guides a user in three places:

- the **first-run flow** at `/onboarding`
- the **pairing flow** at `/pair`
- a handful of **in-app reminders**: the finish-setup bar under the title bar, the "get started" banner on the provider page, and the re-run block in Settings → Discover

Each of them was built on its own, and they had drifted apart.

**Two copies of one screen.** `/pair` had been built as "deliberately the same as the onboarding shell". It was a hand-made copy:

- the brand mesh was pasted inline
- the padding, body width and scene sizes were different
- it had no entrance animation and no window bar, and its wordmark sat inside the panel
- its page title was in the panel, where onboarding puts narration
- its progress row was a second implementation with different label rules and different accessibility hooks

The two first-contact screens looked like two products.

**Three looks for one job.** The finish-setup bar was a muted strip. The provider banner was a dashed card with a sparkles tile and a close button positioned absolutely. The Settings block was a bare heading and a button. All three do the same job: point the user at the next setup step.

**Reminders that went stale.** The finish-setup bar printed one fixed sentence per recorded exit path, and that sentence was often wrong:

- A user who skipped sign-in and then added a key in Settings → Providers was still told "Cognia can't reach a model yet".
- Leaving the first-task cards, or leaving the recommended screen with no sign-in line, recorded `runtime_skipped`. The bar then blamed a missing runtime on a machine that had one.
- The provider banner kept saying "get started by configuring a provider" after a provider was configured.

**Re-entry without aim.** The bar's button and the Settings re-run both resumed at `lastStep`. On the recommended path, reaching the one missing thing meant re-reading the whole plan and re-running it.

**Two smaller defects in the flow:**

- The recommended screen's ready phase kept the "Doing it now… Nothing here needs you" narration and the plan picture, while asking the user to pick a card.
- The ADR-0148 style-pack question appeared on the recommended path, because that path hosts the same first-task step. The step's own comment says the question is for the custom path only.

## Decision

### 1. One guide kit: `components/guide/`

Both full-window flows and every in-app reminder compose the same parts:

| Part | Role |
| --- | --- |
| `guide-motion.ts` | The named entrance recipes: shell, body, scene, copy, callout. They stay CSS, for the reason ADR-0141 gives: an animation that never runs leaves the element at its final styles. |
| `GuideBrandMesh` | The brand substrate, drawn once. |
| `GuideWindowBar` | Back, wordmark and window controls. It is the drag region and close button on a frameless window, and the same row on web and mobile. |
| `GuideNarrativePanel` | The scene, a narrating headline and one line, a status slot, the stepper and an aside. `overflow="band"` caps it to ~30vh below `md`. `overflow="scroll"` lets it scroll with the page, which the web pairing flow needs for its command block. |
| `GuideShell` | The full-window frame. It is hoisted above the steps, so only the keyed body and scene swap. The body is one width in every flow. |
| `GuideStepper` | The one progress row. Only completed steps are clickable, and below `sm` only the current label shows. |
| `GuideHeading` | The step's page `h1`, in two sizes: `step` and `hero`. |
| `GuideCallout` | The in-app guide surface, as a `bar` (a live `role="status"` row) or a `card` (a labelled region). Tone is `brand` or `attention` and lives on the surface, never in the text colour. The close button is always named. |

`StepShell`, `NarrativePanel`, `StepStepper`, `OnboardingWindowBar`, `PairShell` and `PairStepper` stay as thin adapters, so the existing `onboarding-*` and `pair-*` test ids the e2e specs rely on do not change.

In both flows the panel narrates and the step body carries the page heading. The pairing steps' titles moved out of their cards into `GuideHeading`.

### 2. Setup gaps are derived, not recorded

`lib/onboarding/setup-status.ts` answers what is still missing as `SetupGap[]`: `model`, `task-failed` or `first-task`, most blocking first.

- **Whether setup was left unfinished** still comes from the record: `isSetupUnfinished`. That is a skip path with `skippedAt` set and no `completedAt`. A fresh record's placeholder `runtime_skipped` no longer counts as a deliberate exit.
- **What is missing** is re-read from live sources:
  - A **model** gap is raised only on a settled `false` from `resolveLiveModelAccess`. That function applies the same `hasModelAccess` rule the flow uses, with a connected external agent standing in for the flow's process scan. `null` (still probing, or a paired phone) never raises a gap.
  - **`task-failed`** comes from the recorded `task_failed` path.
  - **`first-task`** applies only while the device has no conversations.

`hooks/onboarding/use-setup-status.ts` feeds the finish-setup bar and the Settings status block from one answer, so the two cannot disagree.

- The bar mounts the live probes only after its cheap settings-only precondition passes.
- Settings ignores the bar's dismissal, because closing a reminder is not the same as finishing setup.

The provider banner asks the narrower `useBuiltInModelAccess`. An external agent working on its own credentials changes what adding a provider is *for*; it does not make adding one pointless.

The exit record stays honest as well:

- `skipOnboarding` drops a stale `completedAt`, and `completeOnboarding` drops a stale `skippedAt`.
- The flow records `provider_skipped` only when the user leaves with no model, whichever screen they leave from.

### 3. Focused re-entry

`onboardingHref(focus)` produces `/onboarding?focus=model|task`. The flow reads the focus once on mount through `useSearchParams`, under a Suspense boundary in `app/onboarding/page.tsx`. It does not read `window.location`, because on a client-side push Next commits the new URL only after the page renders. `stepForFocus` then aims it:

| Focus | Custom path | Recommended path |
| --- | --- | --- |
| `model` | the sign-in step | the plan with its inline sign-in |
| `task` | the first-task cards | the ready phase, so the plan is not re-run |

The focus only applies to a step that the device's sequence actually contains. A focused re-entry with no path on record (a migrated legacy user, or one who left through "I've done this before") takes the step-by-step path, so "connect a model" lands on the sign-in, not the intro.

### 4. The recommended ready phase and the style pack

- The ready phase has its own narration, `narrative.express-ready`, and shows the first-run scene.
- `FirstRunStep` takes `showStylePack`, and the flow passes `mode === "custom"`.

## Consequences

- A new guided surface starts from `components/guide/`, not from a copy of an existing screen. Its behavior is pinned by co-located tests (`components/guide/*.test.tsx`).
- Every setup reminder clears itself the moment its gap closes anywhere in the app, and never names something the device already has.
- `/pair` gained a 40px window-bar row on phones, the same one `/onboarding` has always had.
- The Settings status block reports gaps even after the bar is dismissed. That is deliberate, not drift.
- The `onboarding.finishBar.*` copy is keyed by gap, not by exit path. The old path-keyed strings are gone.
