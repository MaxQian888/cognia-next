---
title: "0225 — The tray panel is a glance surface assembled from modules"
description: "The tray quick panel becomes a mini control center: a single column of registered glance modules (status, usage, quota, schedule, activity, quick actions, recents, plugin modules) with sizes, presets and in-place editing, a pinned delegate bar, and a content-hugging height the user caps. It summarizes and routes; the subsystem that owns a thing keeps its controls (Agent Fleet keeps approvals and per-task stop). One Glance snapshot, published by the main window, feeds the tray panel, the Capacity Dock and paired phones. The same module kit renders the mobile home and a mobile Glance drawer, with per-device layouts."
---

# ADR 0225 — The tray panel is a glance surface assembled from modules

**Status:** Accepted
**Date:** 2026-10-11
**Related:** [ADR-0165](./0165-ambient-cost-visibility-and-the-optimization-loop) (one usage projection, spend and all-tools are opt-in), [ADR-0025](./0025-unified-subscription-module) (quota sources), [ADR-0144](./0144-workspace-as-the-unit-of-work) (workspace scope), [ADR-0027](./0027-mobile-offline-and-discovery) (paired phone is a read client), [ADR-0058](./0058-desktop-pet-subsystem) (pet glance), [ADR-0155](./0155-plugins-reach-the-host-through-one-door) / [ADR-0156](./0156-every-in-tree-plugin-is-a-third-party-plugin) (plugin author boundary), [ADR-0093](./0093-selection-toolbar-content-hugging-window) (content-hugging windows)

## Context

Left-clicking the tray icon opens the `tray-panel` window (`src-tauri/src/tray/panel.rs`, `components/tray-panel/tray-panel-view.tsx`). It is an action launcher: a header, an optional usage readout, the Delegate form, and a list of user-editable actions in a box capped at `max-h-64`. Users can customize only the actions (`lib/tray-panel/store.ts`, persisted to the Tauri store under `trayPanel.actions.v1`). The window hugs its content between Rust clamps of 240–720 × 120–900 and closes on blur.

What it cannot answer is the question a menu-bar surface is good at: *what is running, what has it cost, what is left, what happens next*. Every one of those answers already exists elsewhere and is not reachable from the panel:

- Run state (`lib/chat/aggregate-run-state.ts`), background tasks, Agent Fleet and its Island (`components/fleet/`, which owns approvals via `island-permission-actions.tsx`).
- The ADR-0165 usage projection (`lib/usage/usage-glance.ts`), activity stats and the heatmap (`components/usage/usage-heatmap.tsx`).
- Quota windows for credentialed Claude (5h/7d) and Codex (5h/weekly) accounts and the other limit sources (`lib/subscription/limits/`).
- The scheduler agenda, notification unread counts, connectivity and sync, the pet view. Several are already painted by the desktop status bar (`components/desktop/status-bar-*.tsx`).

Four defects sit underneath:

1. The panel's usage readout is fetched only when the tray **title** metric is not `quota` (`lib/tray/usage.ts`). ADR-0165 deliberately keeps `quota` as the title default, so on a default install the panel's usage section never renders. The panel's content is coupled to an unrelated menu-bar preference.
2. The Capacity Dock offers a `quota` gauge mode that is never fed: its initializer passes no quota, so every row resolves to `unknown` (`lib/usage-dock/rows.ts`). Built-but-dormant on all three axes.
3. Each auxiliary window (tray panel, Capacity Dock) receives its own ad-hoc state push from the main window. A separate webview cannot run quota refreshes itself (they read the in-memory unlocked account) and does not activate the account database.
4. On mobile, `/tray-panel` renders "desktop only". The mobile home has its own unrelated glance pieces (active-runs card, quick-actions grid, compact `WelcomeStats`) with their own editor. A paired phone sees none of the desktop's usage, schedule or notifications: `sessionUsage`, `scheduledTasks` and `notifications` are not companion-synced.

## Decision

### 1. The panel summarizes and routes; owners keep their controls

The panel is a glance surface. Every module answers one question at a glance and routes to the surface that owns the subject. It does not re-implement that surface's controls.

| Subject | Panel shows | Panel acts | Owner surface |
| --- | --- | --- | --- |
| Running work | counts by state (running / awaiting approval / failed) and the most recent rows, read-only | open Fleet: focus the Island if it is open, otherwise `/fleet` scrolled to the task | Agent Fleet |
| Notifications | unread count | open the notification center | Notifications |
| Schedule | next run, last outcome | open the scheduler | Scheduler |
| Quota | per-window meters | refresh, retry, enable a discovered source | Subscription settings |
| Usage | stats strip, sparkline, budget | switch period / scope | Usage tab |

Approvals and per-task stop live in Agent Fleet only. The single global control the panel keeps is the existing automation kill switch, because it is an emergency stop with three entry points by design ([ADR-0020](./0020-computer-use-completeness)).

### 2. A module registry, one column, three sizes

A **glance module** is a registered unit: `id`, label key, icon, supported sizes (`compact` one line / `standard` / `expanded`), the snapshot slice it reads, its route-to target, and optional light actions from the table above. Modules stack in **one column**. There is no free 2-D grid: at 320–460 px a grid only produces fragments, and one column is what the phone reuses.

A **layout** is an ordered list of `{ moduleId, size, hidden }` (mobile entries add `home`, §9) plus a `presetId`. Built-in presets are starting points: **Balanced**, **Usage first**, **Agent ops**, **Minimal**. Any edit turns the layout into `custom`; the user can reset to any preset.

The first-party catalogue:

- `status` — the header's overall pill (idle / N running / awaiting approval / automation active) and its counts. Always present; not a stack entry.
- `fleet` — the Fleet summary of §1.
- `usage` — today / 7 days / all-time stats strip, 7-point sparkline, budget meter, top model.
- `quota` — §5.
- `agenda` — next scheduled run and last outcome, unread count, connectivity and sync state, on one line in `compact`, as rows in `standard`.
- `pet` — mood and quick care, when the pet is enabled.
- `activity` — the usage heatmap with 1M / 3M / 1Y.
- `quick-actions` — the existing user-editable action catalogue (`lib/tray-panel/`), rendered as an icon row (`compact`) or a list (`standard`).
- `recents` — recent sessions for one-click resume.
- plugin modules — §6.

The Delegate form stops being a module. It becomes a **delegate bar** pinned to the bottom of the panel: a single growing line, target and "send immediately" in an inline menu, optional autofocus on open. Edit mode can hide it.

### 3. Grouped-list visual language, not cards

The panel is one container. Modules are separated by hairline dividers under small group titles. Metrics render as a horizontal stats strip of number + caption; status renders as an inline dot + label. No card nests in a card. The delegate bar is the only element with a tinted background, because it is the only compound input.

Header: brand, the workspace scope switch (*All* / *current workspace*), the status pill, refresh, settings, close. Footer: **Edit**, the preset switch, *open main window*, and the snapshot's "updated *x* ago".

### 4. Height hugs content up to a cap the user sets

Height follows content up to a user **max height**, set by a slider in settings or by dragging the panel's bottom edge. Past the cap the module stack scrolls while header, delegate bar and footer stay fixed. Width is one of three steps, narrow 320 / standard 380 / wide 460, and modules choose their internal arrangement from the width (a stats strip is horizontal at standard and wide, stacked at narrow). Rust keeps owning window geometry and the left-click behaviour in `tray-panel.json`, because it needs them before the webview exists; the existing 240–720 × 120–900 clamps stay the hard bounds.

Keyboard: ↑/↓ move between rows, Enter opens the owner surface, → expands an expandable row, Esc closes.

### 5. Quota is honest about state

The `quota` module lists every **enabled** source as one thin meter per window showing the **used** percentage (the convention of the Anthropic and Codex usage endpoints; the bar fills toward the limit) and its reset time, and every source whose credentials were **discovered** on this machine but not enabled (a ChatGPT login in `~/.codex`, a Claude login) as a row with an *Enable* action. States are one vocabulary: `ok`, `warn`, `exhausted`, `error` (retryable, with the message), `stale`, `unconfigured`. `stale` is new: a meter whose last snapshot is older than its source's freshness window says so instead of presenting old numbers as current. Refresh and retry are requests to the main window, which owns the unlocked account and the source throttles (`lib/subscription/limits/coalesce.ts`).

External coding tools contribute spend only (ADR-0165 §3); the panel does not invent quota for tools that have no quota source.

### 6. Plugins contribute modules declaratively

A new plugin point `glance.module` lets a plugin register a module as **data**: title, stats items, rows (label, value, status, route target), and buttons bound to the plugin's own commands. The host renders it with the same components and visual language as first-party modules, on desktop and on mobile. A plugin cannot ship React into the panel: the panel is a separate webview, the phone may be rendering a host snapshot, and style must not fork. Plugin module data travels in the Glance snapshot like everything else. The point is registered in `lib/plugin/contracts/plugin-points.ts` and its contract in the plugin SDK catalog.

### 7. One Glance snapshot

The main window publishes one **`GlanceSnapshotV1`**: a versioned, content-free object of numbers, ids, enums, short labels and timestamps, one slice per module, each slice stamped with its own `updatedAt` and freshness. It extends the ADR-0165 rule that what is pushed out of the renderer carries no session content beyond titles the user already sees in the tray.

Consumers:

- the tray panel window, replacing today's `tray-panel://state` push;
- the Capacity Dock, which also receives quota slices, so its `quota` gauge mode finally has data (defect 2; over its own push, amended in phase 4);
- paired phones, through a `glance://update` event channel plus `glance_subscribe` / `glance_request` / `glance_quota_enable` companion commands (amended in phase 3, see below).

The usage slice is computed for the panel's own period/scope/metric. It no longer depends on the tray title metric (defect 1).

Freshness: while a consumer is visible it subscribes and receives updates live; when hidden it unsubscribes and the publisher stops computing slices nobody reads. Remote data (quota) is cached per module with a TTL plus manual refresh. Requests from a consumer (refresh, enable source, open owner surface, run quick action, delegate) go back over one request channel and execute in the main window.

### 8. Scope: global by default, filterable by workspace

Modules read global data by default, because the tray is a system-level entry point. The header switch narrows every module that supports it to the current workspace (ADR-0144). A module that cannot be scoped (quota) is labelled *global* while the filter is on.

### 9. Mobile uses the same kit

The module kit is platform-neutral React over the snapshot. On mobile:

- The home screen's active-runs card, quick-actions grid and compact stats become modules of one mobile layout with one editor. Each mobile layout entry carries a `home` flag: pinned modules also render on the home screen, in layout order; the drawer always renders every visible module. `settings.mobileHomeLayout` migrates into the new layout model, its current sections becoming the pinned entries.
- A **Glance** button in the mobile top bar opens a bottom drawer (`components/ui/drawer.tsx`) rendering the full mobile module stack: the phone's tray panel.
- A standalone phone computes slices from its local data. A paired phone renders host slices for subjects it cannot answer itself (Fleet, usage, activity, schedule, notifications, quota, and the pet, whose on/off is a desktop setting) and labels each with its source host and age. A module whose data is unavailable on the device says so in place.

### 10. Layouts persist per device in settings

Layouts, presets and per-module options move into Dexie `AppSettings` (`trayPanelLayout` for desktop, the mobile layout for mobile), so they are backed up and account-synced like the mobile home layout already is. Desktop and mobile layouts are independent; each can copy the other's. The action catalogue under `trayPanel.actions.v1` is imported once into settings and then read from there.

### 11. The menu-bar title is composable

The tray title becomes an ordered list of fields: usage for one or more periods (`1D 103.3M · 7D 12.6B`), running count, awaiting-approval count, lowest remaining quota %. It stays **off** by default (ADR-0165). On Windows the title is a no-op; the settings UI says so instead of offering a control that does nothing.

### 12. Editing happens in place and in settings

The panel footer's **Edit** enters an in-place edit mode: drag handles (dnd-kit), per-module size and visibility, an *add module* list, preset switch, done. Settings → Desktop → Tray panel offers the same layout model as a full editor with a live preview, plus width, max height, title fields and the action catalogue editor. Both write the same settings field.

## Delivery

Each phase is complete on its own, with co-located tests, both locales, a changeset and docs, and is committed separately.

1. **Registry, snapshot, desktop panel.** Module registry and the first-party modules, `GlanceSnapshotV1` and its publisher, the rebuilt panel (header, stack, delegate bar, footer, width steps, max height, keyboard), Fleet routing, quota states including `stale`, defect 1.
2. **Editing.** In-place edit mode, presets, the settings editor with live preview, the settings migration of layouts and actions.
3. **Mobile.** Mobile home migration onto the kit, the Glance drawer, the paired-phone `glance` channel, per-slice source labels.
4. **Extensions.** The `glance.module` plugin point and SDK contract, the composable menu-bar title, the Capacity Dock quota feed (defect 2).

## Consequences

- `tray-panel://state` is replaced by the snapshot channel; its tests move with it. The Capacity Dock keeps its own push and gains the quota slice on it (amended in phase 4).
- `AppSettings` gains the desktop layout field and the mobile one (`mobileGlanceLayout`); `mobileHomeLayout` is read into the latter until a phone first saves it. No Dexie table changes.
- A new plugin point and SDK catalog entry; `plugin:contract:check` and the runtime-point reachability test (`runtime-proof-audit.test.ts`) cover them (amended in phase 4: `audit:slots` walks UI slots only).
- Two documentation drifts are corrected: the `action-icon.tsx` reference in `lib/tray-panel/types.ts` (icons resolve through `lib/a2ui/resolve-icon`), and the `BYPASS_PREFIXES` reference in `app/tray-panel/page.tsx` (the bypass list is `lib/shell/bypass-routes.ts`).
- Agent Fleet stays the only place to approve or stop an individual task; the panel's Fleet module is pinned by a test to expose no approval or stop control.

## Verification

- Registry: every first-party module declares its sizes, owner route and snapshot slice; a registry test fails on a module without them.
- Snapshot: a schema test pins `GlanceSnapshotV1`; a content test asserts no message text, prompt or file path appears in any slice.
- Defect 1: on a default install (title metric `quota`) the panel's usage module renders.
- Defect 2: with a credentialed quota source, the Capacity Dock `quota` gauge shows a ratio, not `unknown`.
- Mobile: the drawer renders the same modules from local data (standalone) and host slices with source labels (paired).
- Desktop shell smoke: open the panel from the tray, resize by edge drag, edit and reorder, open Fleet from a row, delegate a task.

## Amendment (phase 3): the paired-phone channel is an event channel, not host-state

§7 named a `glance` channel on the host-state service. The service turned out to be a durable, ledgered protocol built only for sessions: closed channel kinds, reducers, one global sequence that every replica processes, and Dexie ledger rows for every commit. A glance snapshot is the opposite: ephemeral, recomputed from React sources in the main window, worthless once superseded. Phase 3 therefore follows the precedent `fleet://update` and the Files library set for desktop data on a phone:

- `glance_subscribe` (`host.observe`, read) announces, renews or ends a lease with the phone's **demand** (the host-sourced modules on screen and the options they depend on, never its layout) and answers the newest snapshot. The lease is keyed on the verified device id plus the phone's consumer id, with the tray panel's 60 s TTL.
- While a lease is live the desktop builds for the merged demand and pushes each snapshot on the opt-in `glance://update` event channel. The phone's copy never carries the tray action catalogue or the goal title.
- `glance_request` (`host.observe`, read) refreshes everything or one quota source; `glance_quota_enable` (`client.write`) turns quota queries on for a vault account. None of the three is replayed from the offline queue.
- The desktop advertises `glance.remote`; a headless brain answers `headless_host`, and the phone says in place that the host does not share glance.

The pet joined the host-sourced subjects: its profile syncs, but whether it is on (`petSettings`) is desktop-only.

## Amendment (phase 4): plugin modules, the title, the dock

Phase 4 settled five points the sections above left open or got wrong:

- **Plugin modules on a paired phone are read-only.** A paired phone shows the desktop's plugin modules, never its own, labelled with the host like every desktop slice; their actions render disabled with "Runs on your desktop", and no write command is added for them. The demand names plugin entries (`plugin:<pluginId>:<id>`, at most 24) and gains `catalog`, so the phone's editor can offer the desktop's plugin modules while nothing host-sourced is on screen. A phone that is not paired runs its own plugins. The demand changed before the paired-phone channel was released, so no deployed phone or desktop speaks the phase-3 shape.
- **Plugin actions are named, not commanded.** A consumer sends `plugin-action` with the module entry and the action id; the main window looks the command up in what the plugin published and runs only that plugin's own `<pluginId>.<command>`.
- **The Capacity Dock keeps its own push.** §7 and the consequences said the dock's push would be replaced by the snapshot channel. Its budget rows are a day's spend per provider with unpriced turns counted, which is not a glance slice, so the dock keeps `usage-dock://state` and the main window adds the glance quota slice to it, built by the panel's builder (no login discovery; refreshed on the shared throttle while the dock is up). Quota mode draws one row per queried source, its tightest window's used share, instead of one account-wide figure on every provider row.
- **The title shows quota as used %.** §11 said "lowest remaining quota %". The panel shows quota as used %, so the title's quota field is the highest used share, the same convention (the user's choice). Title fields live in `TrayDisplayPrefs.titleFields`, next to the readout mode in Settings › Desktop › Tray rather than in the tray panel's settings (§12), and stay per desktop. A title stored before fields existed migrates to the one number its metric named. Windows offers no title option and says why.
- **The budget readout had no number.** The tray's usage feed never folded the cost budget into its glance, so the `budget` metric left the icon badge and the tooltip blank. Every glance build now folds the same `usageGlanceBudget`.

