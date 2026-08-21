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

### Chrome and layout

The flow owns the whole window. `isOnboardingRoute` (`lib/onboarding/route.ts`)
makes `DesktopAppShell` render bare children on `/onboarding`, so the title bar,
guild rail, status bar, terminal dock, extension host bar and the residual
finish-setup notice are all absent for the length of setup; the mobile wrapper
already hid its tab bar and hands the route a definite `h-[100dvh]` column.
Setup rendered inside the workspace frame was advertising an app the user has
not finished setting up — and the finish-setup bar, whose whole job is to send
someone back here, was mounting on the page it points at.

It is deliberately **not** in `lib/shell/bypass-routes`. That list means
something narrower: mid-task deep links (`/pair`, `/oauth`, `/share-target`) and
the small frameless Tauri windows, which own the viewport and keep the document
scroll. The takeover is a full-height flex column that suppresses the same
chrome for a different reason, and it answers to the flow rather than to the
shell.

Suppressing the title bar removes the frameless window's drag region and, on
Windows and Linux, its only close button — so `OnboardingWindowBar` draws its
own: Back, the wordmark, `data-tauri-drag-region` across the slack, and
`WindowControls` (`components/desktop/window-controls.tsx`) at the trailing
edge. `useWindowChromeMode()` is the three-valued rule that surface reads —
`none` in the web shell, `traffic-lights` on macOS (draw nothing, reserve 80px
on the leading edge or the content lands under the native buttons),
`buttons` everywhere else under Tauri.

Inside, one geometry: a flush full-height rail with a hairline trailing edge and
a connected stepper, a scrolling body, and a flush action row. Radii belong to
the content, not the window — `rounded-xl` for every framed block (the same
value `components/ui/card.tsx` uses) and the buttons' own `rounded-md`. The
first version floated a `rounded-2xl` rail card in a padded gutter beside flush,
square content and hard-coded `dark` on it, so the same screen was arguing about
whether it was a page or a dialog, and a light-theme user got a black slab.

Back exists once, in the window bar, because that row exists at every width; the
rail is hidden below `md`, so hosting it there had required a second copy in the
narrow progress bar.

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

### Reaching a model

Three things can give a device model access, and no two of them live in the
same place, so `hasModelAccess` takes all three rather than reading settings
itself: the chat path's own probe (`useCredentialStatus` — a keyring key, an
OAuth bearer, or a resolved BYOK provider), a settings-resolved AI-SDK provider
(`resolveStandaloneProvider`, which the Anthropic-only Tauri probe cannot see),
and the legacy `settings.apiKey` slot. An already-authenticated `claude-code`
the scan found counts as a fourth.

It previously read `Boolean(settings.defaultProvider)` as "has a subscription".
That field is the *active default provider id* (`"openai"`, `"anthropic"`, …),
not evidence of a credential, and nothing in the sign-in path writes it — so
the flow believed a user who had just connected Claude Pro had no model, and
believed a user who had merely picked a provider in Settings did.

The verdict is **latched** at the first settled probe, for the reason the gate
verdict is: `resolveStepSequence` drops the sign-in step when it is true, and
`nextStep` returns the *first* step when the step you are standing on is no
longer in the sequence. A live verdict flips exactly when the user signs in —
so it would re-sequence underneath them and send the next Continue back to the
start of the flow.

### What the sign-in step offers, and what connecting writes

**The offer depends on what the shell can use.** Subscription accounts live in
the OS keyring and resolve through `resolveAccountEnv`, which returns nothing
in standalone mode — a browser with no Companion target, or a phone in BYOK
mode. Chat there goes through `resolveStandaloneProvider`, which reads
`providerSettings` only. Offering three subscription sign-ins on those shells
meant the entire browser onboarding (welcome → provider → first run) could
complete without producing one usable credential, so standalone shells get the
BYOK card alone, under their own heading.

**Connecting writes three pointers**, because three consumers read three
places: the vault's active pointer (`setActiveAccount`), the ADR-0028 scoped
default (`setProviderDefaultAccount`), and `defaultProvider`. Without that last
one `build-options` falls through to its literal `"anthropic"`, so a user who
connected ChatGPT had their first run dispatched to Anthropic.
`setDefaultProvider` also re-syncs `defaultModel`, keeping the pair coherent.

**The key panel offers the whole built-in catalog**, not an Anthropic field.
Three subscription cards cover Anthropic, ChatGPT and OpenCode; everyone else —
OpenAI, Google, a self-hosted Ollama, DeepSeek, an Anthropic-compatible
endpoint like Kimi or GLM — previously had no first-run path and had to find
Settings → Providers unaided. A searchable combobox over `PROVIDERS` (77
entries, grouped flagship → local → the long tails) is what makes that length
usable, and the form adapts to `getProviderRequirements`: a key field only
where a credential is required, a base URL only where one is needed, prefilled
with the well-known port for a local server. Drafts are validated with
`getBuiltInProviderReadiness` — the same rules Settings validates against, so
this step cannot form a second opinion about what "configured" means.

A provider that needs *neither* a key nor a base URL is one this panel has no
fields for (Amazon Bedrock wants a region and an access key pair). Those say so
and disable Save rather than "succeeding" on an empty form. The test is derived
from the requirements, not a hard-coded id list, so a provider added later
classifies itself.

**A pasted key goes to `providerSettings.anthropic`** (plus `enabled`), with
the legacy `settings.apiKey` written alongside so the boot-time push into the
Rust `ApiKeyState` stays in step. Writing only the legacy slot left a browser
user holding a key that nothing in their shell reads.

**The Anthropic dialog keeps its own default.** The step used to force
`initialMode="subscription"`, overriding `discovered ? "reuse"` — pushing a
machine that already has a Claude Code login, the exact machine the scan step
celebrates, through a full browser PKCE round-trip.

Connecting shows what it connected (account, tier) and lets the user continue
from the action row, rather than advancing out from under them.

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
