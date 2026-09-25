---
title: ADR-0058 — Desktop Pet Subsystem
description: "Backfills the architecture record for the pet subsystem (components/pet/, lib/pet/, hooks/pet/, stores/pet/, types/pet/, src-tauri/src/pet_window/) against its actual, current shape — a three-window-role model (main/overlay/popup), a Dexie-vs-Zustand state split, a subsystem-agnostic event bus, and a three-skin (SVG/Live2D/sprite-v2) renderer — none of which is recorded anywhere else. Also records this wave's additions: unified drag/throw physics between the browser widget and the Tauri overlay, an opt-in ambient Twin-awareness signal, a global hotkey + persisted custom-shortcut fix, macOS window-climbing, tray quick actions/mood display, and Codex-compatible sprite-pet imports. Amended 2026-09-25 (D9–D11): the pet is desktop-shell only end to end, a summon switches it on through one owner, radar reports reach it with an Open Insights action, and ⌘K and bindable shortcuts reach it."
---

# ADR-0058 — Desktop Pet Subsystem

**Status**: Accepted (2026-07-01); amended 2026-09-25 (D9–D11)
**Authors**: Max Qian + Claude
**Supersedes**: `docs/superpowers/specs/2026-06-02-pet-system-design.md`, `docs/superpowers/specs/2026-06-05-pet-llm-deepening-design.md`

## Context

The pet subsystem is one of the largest in the repo (127+ co-located test files spanning `components/pet/`, `lib/pet/`, `hooks/pet/`, `stores/pet/`, `types/pet/`, `src-tauri/src/pet_window/`) and, unlike every other subsystem in the Subsystem Map, had no ADR. It grew from two design docs — 2026-06-02 (the original nurture-loop + SVG-skeleton spec) and 2026-06-05 (the LLM-deepening + performance-audit follow-up) — both of which explicitly deferred work that has since shipped:

- The 2026-06-02 spec's "Out of scope" section deferred the **Tauri transparent always-on-top desktop-pet window** ("no new Tauri window / no new Rust") and **Lottie/Rive/sprite-sheet skins** — both now implemented (the `overlay`/`popup` window roles below, and the Live2D skin).
- The 2026-06-05 spec's goal statement deferred **Shimeji-style window-climbing** ("behavior richness... explicitly out of scope this wave") — now implemented (experimental, Windows + macOS).

This ADR records the architecture as it actually stands, then documents the interaction-unification / Twin-awareness / platform-capability work added in this pass.

## Architecture

### Window-role model

The pet's Next.js route tree is shared across three Tauri webview roles, resolved once by `lib/pet/window-role.ts:getPetWindowRole()` from the window label:

| Role | Window label | Route | Owns |
|------|-------------|-------|------|
| `main` | `"main"` | (app shell) | The event bus + controller (XP/needs/progression) + the in-app floating widget (`components/pet/pet-widget.tsx`) |
| `overlay` | `"pet"` | `/pet-overlay` | Presentation only — the transparent, always-on-top, frameless sprite window (`components/pet/pet-overlay-view.tsx`) |
| `popup` | `"pet-popup"` | `/pet-popup` | Presentation only — the right-click quick-menu + talk composer, a dedicated window (not a resize of the overlay, to avoid a resize/reposition race — see `src-tauri/src/pet_window/popup.rs`) |

`components/pet/pet-mount.tsx` mounts the controller/event-bus/command-registration logic **only** in the Tauri `main` window (web and mobile are excluded by the shared availability gate) — `overlay`/`popup` explicitly no-op, so XP is never double-awarded across windows. Cross-window state (visual state, bubbles, one-shots, user interactions) flows over a `BroadcastChannel` bridge (`lib/pet/events/cross-window-bridge.ts`).

### Data flow

```
subsystems (chat/agent-team/goal/scheduler/connector/terminal/workflow/twin/radar)
    → lib/pet/events/sources/*.ts (thin adapters, one per subsystem)
    → PetEventBus (lib/pet/events/pet-event-bus.ts — singleton, mirrors lib/connectors/bus.ts)
    → lib/pet/runtime/pet-controller.ts (serialized promise chain)
         ├─ lib/pet/runtime/apply-event.ts → XP/needs/growth (pure)
         ├─ lib/pet/state/reducer.ts → PetVisualState (pure)
         └─ lib/pet/achievements/check.ts
    → Dexie (lib/db/pet.ts) persists the durable PetProfile
    → stores/pet/pet-store.ts (Zustand — ephemeral visualState/oneShotQueue/bubble/minimized/position only)
    → hooks/pet/use-pet.ts (Dexie useLiveQuery + lib/pet/runtime/pet-view.ts's pure view derivation)
    → components/pet/pet-renderer.tsx → skins/{svg-skin.tsx | live2d-skin.tsx | sprite-v2-skin.tsx}
```

**Dexie vs. Zustand split** is deliberate: the durable record (profile, needs, XP/level/stage, achievements, bindings) lives only in Dexie and is read reactively; `usePetStore` (Zustand) holds only frame-to-frame ephemeral state, persisting just `{ minimized, position }` to `localStorage` (key `cognia-pet-ui`) via `partialize`. This is what let cross-window sync ride Dexie's own cross-tab reactivity instead of a bespoke sync protocol.

### Event bus

`PetEventBus` decouples every subsystem from the pet — subsystems never import pet internals, they call `emitPetEvent(...)` through a source adapter in `lib/pet/events/sources/`. The controller maps events through a priority-ordered pure reducer (`error > waiting > review > thinking > team-run`, else needs-derived resting state) and a `PASSIVE_KINDS` set (`idle`, `inboundMessage`, `scheduledRun`, `scheduledRunDue`) whose resting state defers to a persistent `unwell` care condition rather than overriding it. Only kinds with no expressive state of their own belong there: a kind that maps to `thinking` or `happy` would have that state suppressed by `restingWithCare`, making its reducer case dead.

### Skin system

`components/pet/skins/resolve-effective-skin.ts` picks among `svg` (default, built-in vector, `motion/react` variants), `live2d` (user-imported models, lazily-loaded pixi.js canvas host with a strict-mode-safe init gate), and `sprite-v2` (validated Codex-compatible v2 atlases stored in Dexie). Imported skins fall back to SVG when their selected asset is missing or cannot render. The `PetSkin` interface (`types/pet/skin.ts`) remains the stable seam, so all three renderers share the same visual-state machine and surfaces.

## This wave's decisions

### D1 — Unify interaction physics between the browser widget and the Tauri overlay

The Tauri overlay had richer interaction (release-velocity throw physics via `lib/pet/behavior/ballistics.ts` + `lib/pet/overlay-geometry.ts`, body-zone hit reactions via `lib/pet/interaction/hit-zones.ts`) than the in-app widget (a plain `framer-motion` `drag`, no throw, no zone reactions) — a real cross-surface experience gap.

**Decision**: extract the click-vs-drag-vs-throw pointer state machine into a surface-agnostic hook (`hooks/pet/use-pet-drag-gesture.ts`) that reports deltas/velocity and lets the caller decide what "moving" means — an OS window position (overlay) or a local DOM offset (widget, via a new `hooks/pet/use-pet-widget-throw.ts` reusing the same `stepBallistic` physics against the widget's own container bounds). The widget's drag offset now persists through `stores/pet/pet-store.ts`'s pre-existing `position` field — dead code before this change (declared, documented, never read or written by `pet-widget.tsx`) — rather than adding a new one. Body-zone taps on the widget play the same local one-shot flourish the overlay does, but deliberately **do not** grant XP (XP stays on the interaction panel's explicit "Pet" button), matching the overlay's own separation between the zone flourish and the XP-granting `petted` event.

### D2 — Opt-in ambient Twin-awareness

The pet's only prior Twin coupling was one-way and LLM-side-channel-only: `lib/pet/llm/character-persona.ts` reads a Twin's precomputed, already-PII-redacted `voiceSummary` to flavor pet *speech text* when chatting through a Twin-bound `Character` — it never influenced mood/animation.

**Decision**: a new opt-in `PetSettings.twinAwareness` (default off, mirrors `proactive`/`llmSpeak`'s opt-in shape) lets the pet's mood react to a **single user-picked Twin's** background job activity via a new `lib/pet/events/sources/twin-activity-source.ts`, itself wired through the *same* `PetEventBus` every other source uses. The signal is built only from `TwinJob` metadata (`status`/`kind`/`queuedAt`/`completedAt` — numeric/enum fields with no free-text path), never Twin content (sources, chunks, the distilled profile), so no PII gate is needed on the signal itself — this is PII-avoidance by construction, a stronger and cheaper guarantee than redacting text after the fact. Two derived events: `twinBusy` (any active job; reuses the `thinking` visual state) and `twinMilestone` (a `distill`/`re-distill` job just completed; reuses `happy`). Neither is a `PASSIVE_KINDS` member (an earlier draft of this record said both were; the code never did that, and it is right): each maps to an expressive state, so listing it would suppress the very state it exists to show. Like every expressive state they are transient, and the needs-derived resting state they return to still honors `unwell`. Both carry `0` XP (purely ambient). Bubble copy is Twin-specific ("quietly going through your notes…") so the two ambient states read distinctly from ordinary background work even though they share visual states this wave.

**Rejected**: live LLM-summarized workload commentary (reintroduces a per-tick LLM call the "never touch the model pipeline / tiny token budget" rule exists to prevent); aggregating across all Twins by default (the Twin registry is explicitly multi-instance with no "primary" pointer — an explicit single selection is more legible); mapping job failures to the `error` visual state (would conflate a background twin-pipeline hiccup with "something you're doing right now failed," the highest-priority signal in the reducer).

### D3 — Global hotkey via the existing unified shortcut registry, plus a real persistence gap it exposed

A `pet.toggle-window` command (`lib/pet/commands.ts`, registered through `lib/plugin/commands/registry.ts` alongside `pet.feed`/`pet.play`/`pet.pet`) is bindable through the **existing** `ShortcutRegistry` (`src-tauri/src/shortcuts/`) — no new Rust command, since any registered command id already dispatches through `shortcut://triggered` → `lib/tray/dispatcher.ts`. `pet-widget.tsx`'s own toggle menu item now calls the same `toggleDesktopPetWindow()` the command wraps, so there is exactly one place that owns the open/close + persist logic, and it always re-queries the live OS window state rather than trusting cached component state.

Wiring this up surfaced a pre-existing gap: custom (non-built-in) shortcut bindings only ever lived in Rust's in-process registry, which only re-seeds the three hardcoded built-ins on boot — any user-bound custom chord silently vanished on every restart. Fixed generically in `lib/shortcuts/registry.ts` (not scoped to the pet hotkey alone) by persisting custom bindings to `cognia.store.json` (via `lib/tauri/store.ts`, the same file tray layout/autostart already use) and re-applying them during `hydrate()`.

### D4 — macOS window-climbing (Shimeji-style perching)

`src-tauri/src/pet_window/surfaces.rs`'s perchable-surface enumeration was Windows-only (`EnumWindows`); the pure filter/sort layer (`filter_and_sort_surfaces`) was already platform-independent. A macOS `platform::enumerate()` was added using `core-graphics`/`core-foundation` (already a macOS-target dependency for the automation backend — no new crates) via `CGWindowListCopyWindowInfo`, with self-exclusion by `kCGWindowOwnerPID` against `std::process::id()` (catches every window of this process — main/overlay/popup — at once, simpler than Windows' per-label HWND list and needs no AppKit/`NSWindow` interop). Linux stays on the existing empty stub: Wayland has no stable cross-app window-geometry API (a deliberate compositor security boundary), and X11-only support was judged not worth the maintenance surface for a shrinking minority of Linux sessions. `PetWanderSettings.climbWindows` and the settings UI now say "Windows and macOS only"; the toggle is disabled with an explanatory hint on Linux (`lib/tauri/os.ts:isLinuxPlatform`).

### D5 — Tray mood display + quick actions

`TrayStateSnapshot` gained an optional `pet` field (optional, not required, so existing synthetic test snapshots didn't need updating) populated by `lib/tray/state-snapshot.ts` from the same `computePetView` lazy-decay path the widget itself uses. `lib/tray/status-section.ts` shows a coarse 3-band emoji mood row (not exact percentages — the tray is a screenshot-able OS surface) and a lowest-priority `petNeedsAttention` tooltip/status state (behind automation/goal/streaming). A new `tray.pet` submenu (Feed/Play/Pet + a settings link), gated by `when: "pet.enabled"`, dispatches through the same `pet.feed`/`pet.play`/`pet.pet` commands D3 introduced — zero new Rust-side dispatch logic, since `{kind: "command", commandId}` tray payloads already route through `executeCommand`.

### D6 — Codex-compatible v2 sprite pets through the existing skin seam

The external `$hatch-pet` workflow produces a fixed v2 contract (`pet.json` plus a PNG/WebP `1536×2288` atlas). Cognia does not execute that filesystem-oriented skill inside the browser. On Tauri, the appearance settings instead seed a main-chat Codex task draft containing the user's concept and the `$hatch-pet` instruction; the user reviews and sends it, then imports the completed files through the same settings panel. Web and mobile do not host the pet at all (D9), so neither the import panel nor the agent-task launcher appears there.

The import boundary treats generated files as untrusted: it requires contract version 2, a filesystem-safe stable id, matching path/MIME, the exact atlas dimensions, unique ids, bounded metadata, and a 25 MiB image cap before decoding. Validated blobs and manifest metadata live in the additive Dexie v119 `petSpritePacks` table; `PetSettings.activeSpritePackId` stores only the selected id. A reactive lookup is contained within `sprite-v2-skin.tsx`, so every existing renderer surface gains the skin without duplicating persistence logic. Cognia maps its richer state vocabulary onto the contract's idle/run/wave/jump/failed/waiting/running/review rows and honors pause/reduced-motion preferences. Missing or deleted packs degrade to the built-in SVG skin.

### D7 — One governed rendering boundary per WebView

Independent settings previews, console avatars, the widget, and overlay surfaces could each initialize their own timers, object URLs, or WebGL context. Selection was also a free-form string, optional Live2D resources were silently discarded, and Sprite v2's two gaze rows were unused. These were different symptoms of the same ownership problem: no module governed renderer capability, compatibility, or resource lifetime across surfaces.

**Decision**: `types/pet/skin.ts` now carries typed selection, capability, render-mode, gaze-target, and diagnostic contracts. `lib/pet/skin-runtime.ts` is a per-JavaScript-realm singleton (therefore one per WebView) which awards one live lease using `configuration > interactive > console > thumbnail`, supplies snapshots or placeholders to other previews, caches/revokes object URLs, and exposes development/test resource counters. Live2D context loss receives one automatic retry; the second loss becomes an explicit recoverable degraded state.

All three skins follow `suspended/reduced > held > one-shot > locomotion > semantic state > idle/gaze`. Sprite v2 maps rows 9–10 to 16 clockwise gaze buckets; SVG reuses its face artwork; Live2D uses standard head/eye/body/mouth parameters where present. Web gaze is page-local. Tauri adds a least-privilege local cursor-position command, sampled at no more than 10 Hz and disabled immediately when gaze, visibility, or suspension gates close. No gaze sample is persisted, sent to an LLM, or transmitted.

Live2D import now validates the complete reference graph and persists a versioned `ready`/`degraded`/`invalid` compatibility summary in non-indexed model metadata. Required settings, moc, and textures block activation; missing optional motions, expressions, sounds, physics, and pose are sanitized and reported. Traversal, normalized duplicates, case ambiguity, corrupt images, Cubism 2, and size limits fail before persistence. Official Hiyori/Haru test data is revision- and SHA-256-pinned and downloaded into a test cache rather than committed.

### D8 — One master-detail console and one customization owner

The original `/pet` console accumulated a horizontally scrolling tab strip and card-shaped detail islands, while `/pet → Customize` exposed only a subset of `Settings → Pet`. A user could therefore configure a skin in one entry point but had to leave it to reach speech, sound, Twin, care, or desktop-window controls. The duplicated ownership also made preview fallback and reset semantics drift.

**Decision**: `/pet` is a responsive master-detail workspace. Desktop uses a grouped navigation rail and a separately scrolling detail pane; narrow containers use the same grouped navigation inside a shadcn Sheet. `PetConsoleTab`, `?tab=` deep links, the plugin slot context, and the cross-window message shape remain unchanged. Detail surfaces are flat sections separated by hierarchy and hairlines, while compact widget, popup, and overlay shells keep their bounded chrome.

`components/pet/settings/pet-customization-workspace.tsx` is the sole settings owner rendered directly by both Customize and Settings. It reads `DEFAULT_PET_SETTINGS`, merges every patch through `useSettingsStore.save()`, exposes SVG, Live2D, Sprite v2, interaction, sound, care, Twin, and capability-gated desktop controls, and owns the responsive governed preview plus fallback diagnostics and retry. The profile reset uses a destructive confirmation and remains distinct from the Settings shell's configuration reset.

This is a presentation and ownership refactor only. `PetSettings`, `PetProfile`, Live2D/Sprite records, Dexie versions, XP/economy/interaction rules, and Tauri window protocols are unchanged, so no schema migration is required.

### D9 — Desktop shell only, end to end; a summon switches the pet on, through one owner

Commit 2158d0dc0 made `resolvePetAvailability` answer `unsupported-host` for anything but the Tauri shell, so `PetMount` never starts the controller on the web or mobile. Every surface that reached the pet around that gate kept promising a pet that could not run, and every summon path but one could raise a pet that could not act.

**Summon ⇒ enable.** The overlay owns no controller. `openDesktopPetWindow()` persisted only `desktopPet.enabled`, so a hotkey, the widget menu, the settings switch or the agent's `pet_show` could raise an overlay while `PetSettings.enabled` was off: every click went nowhere, and on a never-hatched install the overlay rendered nothing at all, an invisible always-on-top window. A summon now switches the pet on, in a deliberate order: switch `enabled` on first (leaving `desktopPet` alone, so `PetMount`'s cold-start reconcile cannot race into a second open), open the window (a failed open persists nothing), then re-read the store and persist both flags (`saveSettings` replaces `petSettings` whole, and the native `pet://state-changed` echo saves in between). Hiding the overlay never switches the pet off; the master switch owns that. `pet_show` summons a switched-off pet only for `target: "overlay"`, behind its unchanged `ask` consent tier; the console target still refuses, and a web/mobile host or secondary window refuses both.

**One owner.** The tray's toggle was a native Rust `pet-toggle` that opened with `PetWindowOpts::default()`, ignoring the saved size, position and click-through as well as `enabled`, a second owner beside `toggleDesktopPetWindow()` that D3 said did not exist. It now runs the `pet.toggle-window` command. `pet-toggle` is retired from both native-action whitelists (`lib/tray/native-actions.ts`, `src-tauri/src/tray/dto.rs`), and because both the tray layout and tray-panel actions persist whole payloads, both stores migrate a stored `pet-toggle` to the command at hydrate (`RETIRED_NATIVE_TRAY_ACTIONS`); an unmigrated one would make Rust reject the whole menu push. The Settings → Pet overlay switch routes through the same function. `pet-disable-click-through` stays native: it is the recovery path for a window that ignores the cursor.

**Honest answers.** `/pet` emitted straight onto the bus and always confirmed ("Fed your pet.") with no controller listening. It now goes through the access gate, says the pet lives in the desktop app on other hosts, shows a switched-off pet's record but refuses its care, and reports an action still cooling instead of confirming what the controller then drops. `pet_care` declared a `cooldown` failure it never produced, reporting success and spending the agent's daily ledger while the controller refused; it now reads the same durable interaction-gate state first. Both reads are advisory; the controller stays the authority.

**Desktop-only surfaces.** The `pet` rail entry is `desktopOnly`, and `getSidebarCatalog` drops a desktop-only entry with no host `operation` on the web even with a runtime snapshot (no companion can serve it), which also removes it from ⌘K navigation. The surface contract is `explain` on both columns (`petRequiresDesktopShell`): the route stays deep-linkable and the console explains itself. Settings → Pet is `profiles: ["desktop"]`. The agent's pet tools surface only under Tauri (`!isNativeMobile()` let them through in a browser, the CLI and a headless brain), and the Settings → Tools switch is disabled with a desktop-only note off desktop; the flag's inertness is documented at the type, in the UI and in tests (CLAUDE.md rule 7). The sidebar card's pet row and the title bar's pet toggle render only on the desktop shell, and the title bar's Capture button, which opened Settings → Pet (no capture controls), now opens the console's Insights tab, where `CaptureSettingsPanel` lives.

**Sources that swallowed their first row.** `goal-source`, `workflow-source` and the twin milestone observer returned on an empty first result before taking their baseline, so the first real row became the baseline: a new user's first goal progress and a twin's first distill never reached the pet, and the first workflow run lost its "running" cue. The baseline is now the first callback, empty or not.

### D10 — Attention Radar reports reach the pet as an event, with an action

A radar report reached the pet only through `hooks/pet/use-pet-insight.ts`, which watched the latest report itself and put its verdict in a bubble: no bus event, no visual state, no way to open the report. The scheduler source also mapped the radar task's `completed` to a generic `scheduledRun`, which reset the pet straight back to resting (the runner saves before the scheduler broadcasts) and paid XP and coins even for runs the radar's own guards skipped.

**Decision**: `lib/pet/events/sources/radar-source.ts` emits `radarReport` once per newly saved report, from either the scheduled run or "Run now". It sees only `{ id, generatedAt }` (projected inside the Dexie query) and emits only `{ reportId }`. Detection is a `generatedAt` high-water mark taken on the first callback even with no report yet, so the prune after each save and a deleted newest report never re-announce an older one, and the radar's own opt-in is checked at emit time so enabling it later never replays a report. `radarReport` is `0` XP/coins and maps to `happy`; it is not in `PASSIVE_KINDS` (see the event-bus section), not rewardable, and not claimed by proactive speech. The scheduler source now ignores the radar task's `completed`.

`use-pet-insight` keeps the verdict: it listens for the event, reads the report by id, and speaks the verdict (or first at-a-glance point) through `sayAsPet`, so it takes the PII gate and the shared speak limiter; when either refuses, or the report has nothing to say, a fixed line (`pet.insight.fallback`) announces it instead. No template exists for the kind, so exactly one bubble appears. The bubble carries an optional `PetBubbleAction` (`lib/pet/bubbles/action.ts`, today only `open-console` at a tab) that crosses the bridge as an additive, validated field of the `v: 1` bubble message. `PetBubbleView` renders it as a native button only when its host passes `onAction`: the widget routes to `/pet?tab=insights`, the overlay raises the main window and sends `open-console` over the bridge. With click-through on the overlay ignores the cursor, and the widget and console remain the way in.

**Rejected**: fixed copy only, which would drop an existing feature whose text already passes the PII gate and the speak limiter; a template for the kind alongside the verdict, which would put two bubbles on one event.

### D11 — ⌘K actions and bindable nurture shortcuts

The pet had no palette entries and only its window toggle was bindable. ⌘K now offers "Toggle desktop pet" (the D9 summon path) and "Open pet panel" (a route push, so it works while the pet is off), gated by a required `GlobalSearchHostContext.petHostAvailable` computed the way `PetMount` asks its structural question (host and window role, with the setting held on); off desktop they are hidden, not disabled. Settings → Shortcuts offers the six nurture commands as optional rows, from the id list the commands register from (`lib/pet/command-ids.ts`). All seven pet commands are registered on the main desktop window whether or not the pet is on, with localized titles (the tray's "All Commands" menu shows them), so a bound chord is never reserved at the OS level yet dispatching to nothing. A nurture command refused because the pet is off posts one deduplicated, self-expiring notification (`lib/pet/access/notify-unavailable.ts`) instead of vanishing; a chord usually fires with Cognia in the background, and a switched-off pet has no widget to hold a bubble. Burst refusals stay silent, and the controller's cooldown bubble already answers repeat presses.

## Consequences

- The pet subsystem's real architecture is now discoverable without spelunking through two stale specs and the source tree.
- D1–D5 are each individually reversible (a settings flag, a hook swap, an additive Rust module, an additive DTO field) — none required a Dexie migration. D6 is isolated behind a third skin registration and one additive Dexie table/version. D7 adds only non-indexed model metadata and a renderer owner. D8 changes only UI composition and settings ownership, so neither D7 nor D8 requires a Dexie schema bump.
- D9–D11 add no Dexie table or version. D9 retires one native tray action behind a hydrate-time migration of both persisted tray stores; the rest are settings writes, gating, a new event kind and an additive bridge field.
- Documentation debt intentionally not fully closed: `docs/superpowers/specs/2026-06-0{2,5}-*.md` are marked superseded in-place (not deleted — they retain historical value per the project's "flag, don't delete" convention) rather than rewritten, so the *decision history* they capture (why SVG-over-sprite-sheet, why side-channel-only LLM, the prior-art research) stays intact.
