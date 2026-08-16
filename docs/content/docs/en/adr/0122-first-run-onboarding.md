---
title: "0122 — First-Run Onboarding"
description: "Replaces the first-run dialog with a routed flow that ends in one real, locally-verifiable task, records why a setup was abandoned instead of only that it was, and serves all four shells from one step sequence."
---

# ADR 0122 — First-Run Onboarding

**Status:** Accepted
**Date:** 2026-08-15

## Context

First run was a 597-line `AlertDialog` in `components/shell/onboarding-dialog.tsx`:
provider → character → a six-slide read-only carousel. It had three structural
problems, and none of them were about polish.

**There was no first success.** The flow ended on a carousel and an empty chat
box. A user finished setup having been *told* about six subsystems and shown
none of them. The carousel was also static — it pitched OCR, Computer Use,
connectors and the digital twin identically on every machine, whether or not any
of them were configured, so the one screen that described the product was the one
screen least connected to it.

**State was a single timestamp.** `AppSettings.onboardingDismissedAt` was written
on every exit path — skip, OAuth success, character pick, tour finish, Esc,
click-outside — so "finished", "bailed on step one" and "hit Esc by accident"
were the same value. There was no resume, no partial recovery, and no way to say
anything more specific afterwards than "you closed something once".

**The strongest asset was invisible.** `lib/agent-migration/probe.ts` could
already detect an installed `claude-code`, `codex` or `opencode`, and ADR-0107
could import their commands, settings and past sessions wholesale. All of it sat
behind Settings → Data, which a first-run user has no reason to open. The same
was true of the fourteen executable runtimes in `BUILTIN_EXECUTABLE_PRESET_IDS`.

Multica (`github.com/multica-ai/multica`) solves the first problem by ending its
flow in one real completed issue: it provisions a first agent server-side, writes
an opening turn, and drives the first conversation with a built-in skill. Two of
its load-bearing assumptions do not port. Cognia is a **static export with no
server**, so "the server owns the agent's identity, therefore a client cannot
forge it" has no analogue, and there is no middleware to guard a route. Cognia
also has **no analytics backend**, which zeroes out the attribution half of
Multica's onboarding questionnaire. And Cognia has no workspace object, so its
workspace-naming step maps onto nothing.

## Decision

A routed flow at `/onboarding` that terminates in one real, locally-verifiable
piece of work.

### Step sequence

`ONBOARDING_STEPS` in `lib/onboarding/steps.ts` is the single source of truth for
"what step appears where". Each entry declares the shells it applies to; two are
filtered further at runtime.

```
welcome  →  scan  →  [provider]  →  first-run
                     ↑ dropped once model access already exists
```

| Shell | welcome | scan | provider | first-run |
| --- | --- | --- | --- | --- |
| Tauri desktop | ✅ | ✅ machine probe | conditional | 3 cards |
| Browser | ✅ | ⛔ no local runtime | ✅ | web card only |
| Mobile standalone | ✅ + mode fork | ⛔ | ✅ BYOK | OCR + web |
| Mobile paired | ✅ + mode fork | pairing | ⛔ borrows the desktop's | web card only |

The four contexts are one `OnboardingShell` value resolved by
`lib/onboarding/shell.ts`. The distinction that matters is not desktop-vs-mobile
but **where the compute lives**: a paired phone has no local runtime to scan
for, which is why it is a separate shell rather than one "mobile".

### The scan step

Reuses `probeVendors()` verbatim rather than adding a second detector — that
question already had one honest answer in this codebase, and two would drift. A
vendor whose config file is present is reported as authenticated, because those
CLIs write config as part of signing in. That is evidence, not proof (a revoked
token leaves the file behind), which is why the provider step it suppresses stays
reachable from the residual bar.

Migration runs **inline**, calling `buildMigrationPreview` → `applyMigration`
directly. Bouncing the user to Settings mid-flow would have made the return path
uncertain.

Phase resolution uses two timers, not one. Multica shipped a single timeout here
and had to fix it (their code cites MUL-5119): the daemon was still probing when
the screen flipped to "no runtime found", so users skipped a step that would have
succeeded a second later. Cognia's probe chain is *longer* — filesystem probe,
executable resolution, version queries — so the same false negative is more
likely, not less. A soft 5s budget is suppressed while work is genuinely in
flight; a hard 20s ceiling bounds that suppression so a hung probe still resolves.

### The terminal step

Three fixed starter cards, each obeying four constraints: no extra
authorization, works offline apart from the model call, eyeball-verifiable,
under ~30 seconds. They show what Cognia has that a plain chat app does not —
filesystem, OCR, web reader.

A card whose capability was not confirmed is **hidden, not disabled**. A greyed
card still advertises something the user cannot do, which is the old tour's
failure mode with extra steps. `starterCardsWithFallback` guarantees the step is
never empty.

The card choice *is* the personalization signal; there is no questionnaire. Half
of Multica's exists to feed attribution analytics Cognia does not have, and a
behavioural signal beats a self-reported one. Picking a card opens a session,
queues its fixed prompt through `queuePendingChatPrompt`, and lands the user in
that conversation — so the first output goes through the production send path
rather than a special one.

The built-in `cognia-onboarding` skill shapes that conversation: do not re-greet,
ask at most one question, finish in this turn, create nothing else.

### Anti-forgery without a server

Multica keeps its skill's identity on the server. With no server, the substitute
is structural and pinned by `lib/onboarding/skill.test.ts`: the row id is
*derived* from the codegen'd catalog rather than declared, it lives in the
reserved `skill_builtin_` namespace that only that catalog seeds into, and
boot-time seeding re-asserts the catalog's content over whatever a row holds — so
a direct write does not survive a restart.

### State

Two **top-level** `AppSettings` fields, not one nested object. `SETTINGS_SYNC`
classifies one entry per top-level key, so nesting them would have silently
forced a single classification on both.

| Field | Category | Rationale |
| --- | --- | --- |
| `onboardingProgress` | `device-local` | A phone's onboarding is substantially the pairing flow. Syncing would let a desktop completion mark an unpaired phone as onboarded — simultaneously "done" and unusable. |
| `onboardingProfile` | `shared` | Describes the person, not the device. Moving to a second device should not re-ask. |

`onboardingProgress.path` records *why* a setup ended
(`completed` / `provider_skipped` / `runtime_skipped` / `task_failed` /
`legacy_dismissed`), which is what lets the residual "finish setup" bar name what
is missing instead of nagging generically.

### Routing guard

Static export means no middleware, so `OnboardingGate` decides client-side. It
sits below `RecoveryBootGate` — the app being broken outranks the question of
whether the user is new — and above the shells, so a first-run device never
paints the chat workspace behind the flow.

Readiness is the whole difficulty. Reading un-hydrated settings makes a long-time
user look like a fresh install; reading a session count before Dexie answers makes
an existing user look like a first run. The verdict is latched: `settings.load()`
rewrites the row right after the legacy migration, and a live re-evaluation would
yank a user out of a flow they had already started. The one thing read live is
*settlement* (`skippedAt` / `completedAt`): the flow writes it right before it
navigates home, and a boot verdict of "enter" that outlived that write would
bounce the user straight back into `/onboarding` — every exit became a no-op.
Settlement is one-way and user-driven, so honouring it can only ever release.

### Existing users

`migrateLegacyOnboarding` projects the old timestamp to `path:
"legacy_dismissed"` with the finish bar pre-dismissed. The old field's true intent
is unrecoverable, so we do not guess: no one is re-prompted, and Settings →
Discover offers an explicit re-run. Without that entry point, marking someone
`legacy_dismissed` would mean deciding for them with no way back.

### The tour

Kept, but off the critical path — Settings → Discover, optional. It is now a
fixed A2UI `InteractiveGuide` payload rather than a bespoke carousel, which gives
`components/a2ui/display/a2ui-interactive-guide.tsx` its first product author
(it had been registered in the renderer and used by nobody). The payload is a
constant, not a model turn: the user most in need of "what can this do" is the one
who skipped the provider step and has no model at all. It emits no A2UI actions —
those are dispatched to the agent runtime, and there is no agent behind a surface
nothing generated — so the six Settings deep links are host navigation rendered
alongside it.

## Consequences

- `components/shell/onboarding-dialog.tsx` and the dormant
  `components/chat/welcome/welcome-a2ui-demo.tsx` are deleted, along with the two
  drifted `useEffect` copies that decided when to show the dialog.
- `app/(mobile-onboard)/welcome` and `components/mobile/welcome/` are absorbed
  into the welcome step. The pairing flow itself is unchanged; `/pair` stays, and
  both boot providers plus `SURFACE_CONTRACTS` now name `/onboarding` where they
  named `/welcome`.
- i18n moved from `desktop.onboarding.*` to top-level `onboarding.*` — a sequence
  serving four shells should not sit under a `desktop.` prefix.
- `lib/db/sessions.ts` gains `countSessions()`, so the gate can ask its one
  boot-time question without materializing every session.
- The provider step now reuses the production `AddAccountDialog`s, unchanged from
  the dialog it replaces — the credential surface stays in one place.

## Alternatives considered

**Keep the modal, make it bigger.** Rejected: the size was not the problem. A
dialog's Esc / click-outside still means "gone forever", and that semantic is
what produced the single-timestamp state model.

**Desktop only in v1.** Recommended initially and overruled: the state model was
designed for all four shells regardless, and shipping three of them later would
have meant a second pass over the same sequencing code. The cost landed on
absorbing the two mobile routes, which is why the pairing flow itself was left
untouched.

**Report the paired desktop's capabilities to the phone.** Rejected for now. The
companion handshake's `capabilities` are authorization scopes (`host.admin`,
`agent.worker`, `process.spawn`), not feature flags, so this needs a new
Rust-aggregate → handshake → TS-cache channel. That is the only cross-language
infrastructure this change would have required, and binding it to the flow's
critical path was not worth it — a paired phone gets the requirement-free card.

**A questionnaire step.** Rejected: half its value is attribution analytics that
do not exist here, and the starter card the user picks is a better signal than a
self-reported role.
