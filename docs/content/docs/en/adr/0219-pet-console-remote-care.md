---
title: "0219 — Pet console remote care from a paired phone"
description: "Amends ADR-0058 D9. The pet runtime (controller, overlay, tray, agent tools) stays desktop-shell only, but the /pet console becomes operable from a phone or browser paired to a desktop host that advertises pet.remote-care. The phone reads a projected, read-only mirror of five pet tables through companion sync and sends nine pet_* commands over the desktop-write bridge, so every action still runs in the desktop's single controller and XP is awarded once. Customization, bindings editing, reset, the desktop window and skin repair stay desktop-only and are labelled as such."
---

# ADR 0219 — Pet console remote care from a paired phone

**Status:** Accepted
**Date:** 2026-10-09
**Amends:** [ADR-0058](./0058-desktop-pet-subsystem) (D9: "desktop-shell only end to end" now applies to the pet runtime, not to the console)
**Related:** [ADR-0027](./0027-mobile-offline-and-discovery) (companion sync), [ADR-0021](./0021-webrtc-datachannel-wan-transport) (pairing transport)

## Context

ADR-0058 D9 made the pet desktop-shell only end to end. On web and Capacitor `PetMount` never
initializes, and `/pet` rendered an "unavailable here" empty state whose only exit was back to chat.
That was right for the runtime: the controller is the only writer of XP, needs, cooldowns and
achievements, and a second controller on another device would award everything twice.

It was wrong for the console. The console is where the record of the pet lives, and a user away
from the desk had no way to look in on the pet or care for it, even with a phone already paired to
that desktop. The pet's tables were not part of companion sync, and no companion command reached the
pet, so the phone had nothing to read and nothing to send.

## Decision

### 1. The runtime stays on the desktop; the console does not have to

The controller, the overlay and popup windows, the tray, the agent tools and the plugin pet API keep
D9's rule unchanged (`petRuntimeRequiresDesktopShell` in `lib/runtime/surface-contract.ts`). The
`/pet` surface becomes operation-bound: `{ operation: "pet_get", standalone: "explain",
companion: "remote", offline: "cached-read" }`. An unpaired phone or browser gets the contract's
`/pair` remedy (`petConsoleRequiresPairedHost`) instead of a dead end.

### 2. One controller: actions travel to the desktop

The console resolves a mode once: `local` in the desktop main window, `remote` on a companion
paired to a host that advertises `pet.remote-care`, otherwise an explanation. Every console action
goes through one provider (`usePetConsoleActions`), whose local and remote implementations return
the same outcome type, so the tabs are identical in both modes and never call `emitPetEvent` or a
Dexie writer in remote mode.

Remote actions are nine commands on a new `pet` resource (`protocol/companion-*.json`), bridged by
`desktop_writes_bridge` to `lib/pet/remote/host-dispatch.ts` in the desktop WebView:

| command | effect |
|---|---|
| `pet_get` | Snapshot: availability, the PII-safe `projectPetSummary` projection, cooldowns, presentation (requested skin, on desktop, chat enabled) |
| `pet_act` | One care action (`fed`…`talked`), optionally spending an item; the host prechecks the cooldown before spending |
| `pet_item_purchase`, `pet_item_apply` | Shop purchase (new verb `purchase`) and decor |
| `pet_rename` | Rename, serialized with the controller |
| `pet_soul_generate` | Hatch through the single-flight `hatchPetOnce`; answers `pending` past 25 s |
| `pet_chat_send`, `pet_chat_list`, `pet_chat_clear` | Talk with the pet on the host, with the host's settings, PII gate and rate limit |

The commands are called directly and never enter the durable mobile outbound queue: a care action
replayed minutes later would hit a cooldown or double a reward. Retries carry one idempotency key
per intent, held by the host for ten minutes per calling device. A headless brain answers
`headless-host` (it has no controller), and a desktop whose controller has not subscribed yet
answers `host-starting`; `pet.remote-care` is advertised only by the Tauri desktop.

`pet_chat_send` and `pet_soul_generate` spend the host's model budget, yet they are classed like
`message_send` (`client.write`, low risk, no approval, outside the remote-control gate) rather than
like `goal_subgoals_generate`. A paired phone is the user's own device acting on the user's own
pet; the host's PII gate and the pet's speak rate limit bound each turn, and a hatch runs once per
pet.

### 3. A projected, read-only mirror

Companion sync gains `petProfile`, `petAchievements`, `petInventory`, `petCharacterBindings` and
`petActivityLog`. The profile is projected on the host: the account fingerprint (a raw provider
account id) is replaced by a sentinel and the derived bones travel as `mirroredBones`. Deletions
(used-up items, removed bindings, reset) are tombstoned explicitly, because `Table.clear()` fires no
hooks. The activity log is retention-pruned and reset by profile generation. The pet conversation
(user content) is not mirrored; the phone pages it live with `pet_chat_list`. Live2D and sprite
assets stay device-local, so the phone draws the SVG skin and says so instead of warning.

### 4. What stays desktop-only, and how it is labelled

Customize, Insights, Plugins, binding edits, reset, the on-desktop toggle and skin repair need the
desktop's files, windows or settings owner. `PET_CONSOLE_CAPABILITIES` declares them
`desktop-only`; in remote mode their tabs stay visible with a "Desktop" badge and explain why,
bindings render read-only, and the desktop toggle becomes a status chip. The type, the UI and the
tests pin all three (CLAUDE.md rule 7). Settings → Pet stays `profiles: ["desktop"]`.

## Consequences

- The phone can feed, play, talk, shop, hatch and read the journal, dex and achievements of the
  same pet the desktop shows, and XP is still awarded once.
- Remote actions need the desktop app running and reachable; the console shows connection state and
  freshness and refuses honestly (`host-starting`, `cooling-down`, `headless-host`).
- `grantedCoins` in a `pet_act` reply is a balance difference and can include a concurrent award.
- A backup restore that writes an older `updatedAt` is not re-pulled by an existing mirror cursor,
  the same as every other mirrored table.
