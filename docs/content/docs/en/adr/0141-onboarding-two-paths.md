---
title: "0141 — Onboarding: two paths, one picture"
description: "First run forks into a recommended path that confirms and applies a whole setup on one screen and a step-by-step path that keeps every choice open; the rail is replaced by a narrative panel drawn from live probe data, and the marketing site's brand accents finally cross into the app."
---

# ADR 0141 — Onboarding: two paths, one picture

**Status:** Accepted
**Date:** 2026-08-23
**Supersedes in part:** [ADR-0122](./0122-first-run-onboarding)

## Context

ADR-0122 replaced a 597-line dialog with a routed flow that ends in one real,
locally-verifiable task. That decision holds, and most of its reasoning holds
with it — the two-timer scan policy, the latched `hasModelAccess` verdict, the
three pointer writes a connection makes, the capability-gated starter cards,
the five exit paths, the anti-forgery argument for the built-in skill. None of
that is revisited here.

What did not hold was the shape of the thing, on two axes.

**Four screens, four questions.** The sequence asks about the machine, then
about credentials, then about a first task. On a desktop that already has
Claude Code installed and signed in — the machine the scan step exists to
celebrate — the honest answer to three of those is "yes, obviously". The flow
knew that: it already skipped the sign-in step when the probe found an
authenticated CLI. But knowing it one step at a time still costs four screens,
and every one of them is a screen between a new user and the product doing
something.

**Every screen looked the same.** `--primary`, `--accent`, `--card` and
`--muted` are `oklch(… 0 0)` in both themes — the app's palette is achromatic
on purpose, and chroma is reserved for semantics (`--success`, `--warning`,
`--info`) and workflow-node categories. So the flow was four screens of
`text-sm text-muted-foreground` inside generic `rounded-xl border bg-card`
blocks, with a `w-[15.5rem] lg:w-[18rem]` rail holding three labels and three
descriptions beside a `max-w-[44rem]` column floating in the middle of the
window. Nine words of sidebar, most of a desktop screen doing nothing, and
nothing on screen specific to the step you were on.

The brand was not missing. It was on the marketing site: `web/app/globals.css`
carries the full ADR-0092 V2 palette — `--paper`, `--ink`, `--stone`, cyan
`--action`, amber `--approval` — with both modes and a WCAG rationale per
token. It stopped at the app's door, so a user arriving from cognia's website
met a screen that shared nothing with it.

## Decision

### 1. The welcome screen forks into two paths

`OnboardingMode` is `"express" | "custom"`, persisted on
`onboardingProgress.mode` (device-local, with the rest of that record).

```
express  →  welcome → express                             (2 screens)
custom   →  welcome → [scan] → [provider] → first-run     (unchanged)
```

`resolveStepSequence` takes the answer and filters on it, so nothing
downstream needs to know which path it is on — the sequence already encodes
it. Before the fork is answered the sequence is **the intro alone**, which is
what keeps Back and Continue honest on that screen.

**Presented as a primary button and a quiet link, not two matched cards.**
They are not two equal options; one of them is what almost everyone should
press. Drawing them as a pair would add a decision to the screen whose job is
to remove decisions — and on a phone, where the standalone/paired fork already
occupies two cards, a second pair would put four cards above the fold.

**The runtime-mode fork now commits without advancing.** A phone answers both
questions on one screen: how it runs, then how much it wants to be asked. Both
path controls are disabled until the first is answered, because the runtime
mode is what decides the sequence — starting without one would build a plan
for a shell the user has not chosen.

### 2. The recommended path is one screen that shows its working

`buildExpressPlan` (`lib/onboarding/express-plan.ts`) derives a list from the
same three probes the step-by-step path uses, and the screen runs through
`plan → applying → ready` without navigating.

| Line | Source | Kind |
| --- | --- | --- |
| `migrate-config` | `probeVendors()` (ADR-0107) | action, droppable |
| `import-history` | the ADR-0062 source walk | action, droppable |
| `use-runtime` | an authenticated `ScannedRuntime` | statement of fact |
| `sign-in` | `hasModelAccess === false` | interactive |
| `pair` | shell is `mobile-paired` | interactive |
| `capabilities` | `resolveCapabilities` | statement of fact |

**It confirms before it writes.** Two of those lines write to the user's
machine — the config migration copies another agent's commands, settings,
skills and MCP servers into Cognia, and the history import writes every
readable transcript into Dexie. Neither has an undo. Doing that silently
because the user pressed a button labelled "recommended" is not a shortcut, it
is a decision taken on their behalf, so the list comes first and any action
line can be dropped.

**A line is either an action or a statement of fact.** "We will use the Claude
Code login already on this machine" gets no checkbox, because unchecking it
would not mean "do less" — it would mean "now ask me to sign in again". Only
lines with something to decide render one.

**On a machine with nothing on it the list collapses to two lines** — connect a
model, and here is what you will be able to do — and the heading and subtitle
change with it. This is the intended shape rather than a degenerate case: the
screen is an adaptive list, not a fixed form with empty rows. It is also the
majority first run.

**Sign-in is inline, because it is the one thing that cannot be automated.**
OAuth, a device code and a pasted key all need a human, so "recommended" can
never mean zero interaction. It can mean *one* interaction, in place:
`ExpressSignIn` offers the single most likely option for the shell — the
Anthropic subscription button where the keyring is reachable, a key field in
standalone mode, since `resolveAccountEnv` returns nothing there — with the
full catalogue one disclosure away. That disclosure mounts the real
`ProviderStep` with its heading suppressed, not a second cut-down picker.

**The terminal step renders into the same screen.** `FirstRunStep` is hosted by
the `ready` phase rather than being a destination, which is what makes the path
two screens end to end — and why the starter cards keep their existing test
ids.

**Execution is sequential and in the plan's own order.** The migration writes
the skills and subagents a transcript may reference, so a history import racing
ahead of it can land conversations pointing at things that do not exist yet. A
failed line is recorded and the run continues: the point of the flow is to
reach a first output, and a vendor whose config could not be read is not a
reason to deny that.

**The recommended path exists on all four shells.** A browser's plan is the
sign-in line plus the capability line, which still folds two screens into one;
a paired phone's is the pairing line plus the cards. A path that existed only
on the desktop would be a fork the user cannot find on the device they are
holding.

### 3. The rail becomes a narrative panel

`NarrativePanel` (26rem, 30rem at `lg`) replaces `StepRail` *and* the separate
below-`md` `StepProgressBar`. It takes real width and earns it: it holds a
scene drawn from live data, a line of narration, and — in the step-by-step path
only — `StepStepper`, a horizontal row that keeps the one thing the rail was
actually needed for.

Below `md` the panel becomes a band across the top rather than being swapped
for a different component, so there is no second layout to keep in step and no
narrow-width stand-in left to drift.

**The stepper is hidden on the recommended path.** Its sequence is two screens,
one of which is the intro; a progress row reading "1 of 1" says nothing except
"you took the short path". Its progress is the plan lines completing.

**The panel's copy is keyed independently of the step**, because one screen can
have more than one thing to say: the recommended screen promises "nothing runs
until you say so" while it shows the plan, and that becomes a lie the moment it
starts running it.

### 4. The scenes are drawn from real data

`components/onboarding/scenes/` holds five SVGs built from one shared
vocabulary — a machine frame, a core, chips, connectors — so the flow reads as
one continuous picture. The core never moves between steps; the scan scene's
column of chips *is* the express scene's plan.

Hand-drawn vector rather than screenshots, for three reasons: the app is a
static export, so anything here ships in the bundle and is paid for on the
first-run path; vector adapts to both themes from CSS variables alone; and — the
load-bearing one — it can be driven by live state. A screenshot cannot light up
one node per runtime the probe actually found, dash the connector of an
installed-but-unauthenticated CLI, or tick a plan line the moment it lands.

The first-run scene is the only one where the flow reverses: everywhere else
the chips feed the core, and there the core writes back out, because that is
what the whole flow exists to reach.

### 5. The entrance is CSS, not `motion/react`

The first implementation used `motion.g` with `initial={{ opacity: 0 }}`. That
has a failure mode this screen cannot afford: if the animation does not advance
— a throttled frame loop, a parked subtree, a hidden tab at boot — the element
stays at its *initial* value, and the initial value is invisible. This was not
hypothetical; it reproduced in the component preview, leaving the whole scene
blank.

A CSS `animate-in` degrades the other way. `tw-animate-css` ships
`animation-fill-mode: none`, so an animation that never runs leaves the element
at its own styles, which are the finished ones. Every keyframe added to
`globals.css` for this carries its start state *inside* the keyframe for the
same reason: `onboarding-draw` sets the dash pattern in both `from` and `to`, so
a connector whose animation never plays is drawn solid rather than dashed into
invisibility.

It is also better covered. The `globals.css` guards clamp `animation-duration`
to 1ms and `animation-iteration-count` to 1 across all three reduced-motion
signals — the OS query, the `.reduce-motion` class, and
`[data-reduce-motion="true"]`; `useReducedMotion()` sees only the first. The
scenes still consult `useFlowMotion()`, because a stagger *delay* is not
covered by those guards, and a reduce-motion user would otherwise stare at a
blank panel for its length.

Three motions, all state-bearing: connectors draw themselves in, an in-flight
connector marches (a dashed line cannot also draw itself on — both want
`stroke-dasharray`), and a live core breathes once every four seconds so a
screen someone is sitting on through an OAuth round trip is not a still life.

### 6. `--brand-action` / `--brand-approval`, copied from the site

Added to `globals.css` as hex, **verbatim from `web/app/globals.css`**, so the
two files can be diffed for drift — a rounded oklch conversion would make them
"the same colour" only approximately. Scoped the way `--effort-ultra` is: the
first-run takeover uses them, nothing else does yet.

Accents only. The app's neutral substrate is kept, so walking out of setup into
the workspace is not a colour-temperature jump. And the site spec's usage rule
comes with them: `--action` is 1.69:1 on a light substrate and `--approval` is
2.15:1, so they are strokes, fills and state dots — never a text colour, and
never the only carrier of a state. Every tone in the scenes is also a shape:
solid versus dashed outline, hollow dot versus filled, dot versus check.

### 7. One credential writer

`lib/onboarding/connect-provider.ts` now owns both credential paths, because
both have two callers. A write that drifts between the sign-in step and the
recommended screen is close to undebuggable: the symptom is a first task
dispatched to the wrong provider several screens later, with nothing in between
to suggest why.

## Consequences

- `components/onboarding/step-rail.tsx` is deleted. `onboarding-rail-{id}` test
  ids survive on `StepStepper` — the behaviour did not change, so neither did
  the hooks the suites and e2e specs hang off. `onboarding-progress-bar` is
  gone, having nothing left to stand in for.
- `OnboardingStepId` gains `"express"`; `ONBOARDING_STATE_VERSION` is 2. There
  is no upgrade callback and no Dexie bump: `mode` is optional and
  `resolveOnboardingMode` derives it for older rows from `lastStep` — any step
  past the intro belongs to the sequence that had those steps, and only one
  path had them. A record still sitting on `welcome` gets asked rather than
  guessed for.
- `advanceOnboarding(step, mode?)` takes the path alongside the step. Passing
  no mode means "no new answer", not "forget the old one".
- `vendorLabel` moves into `lib/onboarding/scan.ts` and is shared. This fixed a
  pre-existing defect on the way past: the scan step's migration rows read
  "Import commands, settings and past sessions from claude-code", printing an
  internal slug at someone who has only ever seen the words "Claude Code".
- `ProviderStep` gains `heading?: boolean`, so the recommended screen can host
  it under its own plan line without a second `<h1>` or a broken heading order.

## Alternatives considered

**Keep the four steps and add the fork as a fifth screen.** Rejected: the
recommended path would then be "press Continue on your behalf", and the screen
count would go *up*. The saving comes from folding the questions together, not
from answering them faster.

**Run the recommended path with no confirmation at all.** Rejected on the
grounds above — two of its lines write to disk without an undo. The
confirmation costs one screen that the path was going to render anyway, and it
is the difference between a shortcut and a decision taken on someone's behalf.

**Adopt the marketing site's whole palette, `--paper` substrate included.**
Rejected: the site is warm off-white and the app is cold white, so the last
step of setup would hand over to a workspace at a visibly different colour
temperature. Retuning the app's neutrals is a change to every page in it, and
not one this flow should smuggle in.

**Product screenshots in the panel instead of drawn scenes.** Rejected: bitmaps
in two themes on the first-run path, and a screenshot cannot report what is on
*this* machine — which is the panel's whole reason for taking the width.

**Restructure the step-by-step path too.** Rejected: someone who chose it wants
every step in their hands, and compressing it would blur the only distinction
between the two paths.
