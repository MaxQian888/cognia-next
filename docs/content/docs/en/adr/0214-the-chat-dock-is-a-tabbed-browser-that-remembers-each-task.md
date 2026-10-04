---
title: "0214 — The chat dock is a tabbed browser that remembers each task"
description: "The session summary stops being a dock column that excludes the artifact dock. It becomes a Codex-style card under a title-bar trigger, or floats in the chat gutter. On desktop the chat dock shows one tab strip mixing session panels, artifacts, local-Chromium pages and a React New Tab page that does not start Chromium. Each chat session remembers whether the dock is open, its ordered tabs and the active tab; width stays global. Web pages, localhost included, default to local Chromium, with a per-tab lightweight preview on the system webview. A task's pages close when it goes to the background unless its run is still in flight. A narrow window first shrinks the dock, then folds the sidebar transiently, then floats the dock over the chat."
---

# ADR 0214 — The chat dock is a tabbed browser that remembers each task

**Status:** Accepted
**Date:** 2026-10-03
**Amends:** [ADR-0098](./0098-persistent-workbench-rail) (dock visibility is no longer one global fact for the chat dock), [ADR-0201](./0201-the-desktop-browser-runs-chromium-locally) (backend table: localhost defaults to local Chromium)
**Related:** [ADR-0083](./0083-context-workbench) (scopes, retention), [ADR-0121](./0121-workbench-mobile-drawer-and-panel-customization) (hidden panels stay reachable), [ADR-0123](./0123-context-workbench-vertical-split) (no remounts), [ADR-0055](./0055-agent-browser-loop) (agent browser loop)

## Context

The session summary is a 320px card portalled into a reserved `<aside>` beside the artifact
dock. Opening it collapses the dock, and every dock reveal closes it, so the summary and the
artifact it describes are never on screen together. The card leads with five configuration
rows and reduces the results to counts.

The chat dock has two tab rows in tabs mode (`ArtifactTabStrip` plus the workbench's panel
tabs), and local Chromium adds a third inside the browser panel. A conversation with no
artifacts opens on "No artifacts yet". Whether the dock is open is one persisted boolean
shared by every conversation, which ADR-0098 chose to stop the dock reopening as the user
moved between *artifact* tabs.

The workbench's `activatedPanelIds` is per resource scope and serves as the tab list, the
mount gate and the lifecycle memory at once, with no payload. It cannot hold an ordered list
of tabs that includes pages with URLs.

## Decision

### Summary card

- A card under a trigger in the chat header row (title-bar `actions` outlet on desktop),
  rendered as a Radix popover clamped to the chat stage. When the dock is closed and the
  gutter beside the centred chat column fits it, it floats there instead.
- Width `min(288px, chat width − 16px)`. It never writes `dockCollapsed` or `userDismissed`.
- Rows: project and branch; run progress (todos, only while running); needs-you (only when
  pending); changes with `+/−` line totals; artifacts; sources with add and "View all". Each
  row opens the matching dock tab; "View all" opens the `metadata` (Task overview) panel.
- Per-row visibility `always | auto | never` lives in `AppSettings.sessionSummaryCard`.
- The reserved summary column, `summarySessionId`, `openSummary` and `closeSummary` are removed.

### One tab strip

- On desktop the chat dock renders a single `DockTabStrip`. A tab is a session panel, an
  artifact, a page or the New Tab page. The workbench's own tab strip and rail, and
  `ArtifactTabStrip`, are not rendered by this host; `LocalChromiumPreview` hides its tab row.
- The ordered list lives in a new per-session store. The workbench store keeps mounting and
  lifecycle: the dock drives it with `navigatePanel` and `closePanelTab`, so ADR-0123's
  no-remount rule and ADR-0121's reachability rule hold. Artifact tabs mirror
  `artifactStore.openArtifactIdsBySession`, which stays the owner of which artifacts are open.
- The New Tab page is a React panel. It does not start Chromium. Choosing a URL turns that
  tab into a page.

### Per-task memory

- Each chat session stores `{ open, tabs, activeTabId, lastUsedAt }`. Dock width stays global.
  Entries are pruned like workbench scopes (30 days, 200 entries).
- On a conversation switch the stored `open` wins over `parkIdleArtifactDock` and over the
  desktop raise in `useDockAttentionSignal`. A session with no record keeps today's rules.

### Browser

- One local-Chromium session serves the whole desktop. Every local session opens the `default`
  profile and the runtime lets one session hold a profile, so a session per pane or per task
  failed with `browser_profile_in_use`. The session is created on the first page and closes
  after a minute with no page held and nobody watching.
- Pages have owners: `chat:<sessionId>` for a conversation's page tabs and its agent,
  `pane:<id>` for a browser pane outside the dock. A popup goes to the owner of the page that
  opened it (the runtime now reports `openerId`). One owner holds at most 8 pages.
- Every runtime op may name a `pageId`, and then acts on that page instead of the one in front.
  Each page has its own in-flight action, pending dialog, console and network buffer. A task's
  agent keeps working on its own page while the user looks at another, and neither refuses the
  other with `browser_action_in_progress`. Only the pane on screen activates a page. The
  screencast now follows the page in front; before, it stayed on the page it started on.
- A page tab stores `{ url, title, engine }` per conversation. The `browser` panel is not a tab
  of its own: it renders the page tab in front, remounted per tab, and a reveal with no page
  open lands on the New Tab page. Links, `browser_open` and the External Bridge's `revealPane`
  become page tabs. A user's link reuses a tab on the same address. An agent reuses the tab
  whose page it drives. A request for a background conversation lines its tab up there without
  taking over the dock on screen.
- Switching away closes the leaving task's pages unless its run is streaming or awaiting
  approval. Those close when the run settles, if the task is still in the background. Switching
  back recreates a page only when its tab becomes active, at the remembered address.
- Agent routing and the browser tools' last URL are per chat session. An agent's first page
  fills the tab its conversation is showing. An External Bridge client is pinned to the
  conversation on screen at its first call. A pane that adopted an agent's user-chrome session
  detaches from it on unmount instead of closing it.
- Web pages default to local Chromium, localhost included, once it is installed. An empty pane
  outside the dock stays on the webview. Without Chromium the system webview serves the page
  and the New Tab page offers the install control. A page tab can switch to the lightweight
  preview (system webview) from its menu or the address bar's engine chip. The lightweight
  preview keeps element pick, annotations, Adjust, CDP controls and the inspection rail. Leaving
  Chromium closes the tab's page. `browser_annotate` on a Chromium page moves the
  conversation's page there and asks the model for a fresh snapshot (`browser_engine_switched`):
  a Chromium snapshot's refs mean nothing in the webview.

### Narrow windows

The dock shrinks toward its floor while the chat keeps 420px. Then the left sidebar folds to
the rail through a runtime-only override that leaves the saved preference alone. Then the dock
leaves the row and floats over the chat with a scrim.

Tablet and mobile keep the Sheet and drawer. The card works there as a popover.

## Consequences

- The chat dock no longer obeys ADR-0098's "one global fact" for visibility. Canvas, the
  workflow editor and the project editor still do.
- ADR-0201's table changes for localhost: React DevTools and other extensions now work on dev
  servers. The cost is one Chromium page per open page tab while visible, bounded by the
  runtime's 32-page cap and by closing background tasks' pages.
- Localhost pages lose the embedded-only tools unless the user picks the lightweight preview.
- Line totals depend on the task-workspace ledger. Web sessions show file counts only.
- The previously unwired `sourceCount` and `uncommittedChangeCount` dock badges are now wired.
