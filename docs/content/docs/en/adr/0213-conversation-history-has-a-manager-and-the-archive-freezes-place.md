---
title: "0213 — Conversation history has a manager, and the archive freezes a row's place"
description: "Conversation history gets a dedicated /conversations page with Active and Archived tabs. It is built on the chat sidebar's list model, filter controller, row menu, bulk bar and write boundary, not a copy of them. A message the user sends to an archived conversation unarchives it. Background writes do not. Pins and folders survive archiving but are frozen inside the archive. The archive gains Empty archive, an inactivity auto-archive maintenance task, phone multi-select and a keyboard shortcut. Settings → Sessions narrows to the agent-runtime view."
---

# ADR 0213 — Conversation history has a manager, and the archive freezes a row's place

**Status:** Accepted
**Date:** 2026-10-03
**Related:** [ADR-0002](./0002-scheduler-full-agent-resolution) (scheduler maintenance tasks), [ADR-0009](./0009-platform-connectors) (the inbox keeps its own archive), [ADR-0129](./0129-unified-global-search) (⌘K `is:archived`), [ADR-0144](./0144-workspace-as-the-unit-of-work) (workspace scope), [ADR-0200](./0200-files-is-a-view-that-keeps-what-you-keep) (the Files page as a precedent for a feature page over existing data), [ADR-0204](./0204-a-project-coordinator-runs-threads-in-the-background) (coordinator and threads)

## Context

Two surfaces were managing conversation history, and neither did it well.

**Settings → Agent runtime → Sessions** was a second session manager that went
around the shared write path (`useSessions` → `useConversationRowActions` →
`SessionRowMenuItems`). Its delete skipped teardown: no sidecar close, no IM
disarm, no `SESSION_DELETED`, no Host routing. Its rename left `titleAuto`
set. "Resume" set the chat store while the user stayed on `/settings`. It
listed embedded, IM and archived rows without marking them. Cost ignored the
detailed effective cost. It hand-rolled its own time and cost formatting and
its own delete confirm. It had no sort, no bulk actions, no archive and no
export.

**The archive** was a mode of the chat sidebar, and it had gaps:

- Nothing showed how many conversations were archived.
- An open archived conversation looked like any other.
- "Search everywhere" dropped the archive.
- Pinned or foldered archived rows half-worked.
- Scope-header unread pills counted the *active* rows.
- Preview caps made "Select all" select only part of the list.
- The phone had no bulk actions and no way back from an empty archive.
- The archive split was computed in three places.

## Decision

### 1. One manager page, built from the list's own parts

`/conversations` (`app/conversations/`, `components/conversations/`,
`hooks/conversations/`, `lib/conversations/`, `stores/conversations/`) shows
every exposed conversation in every workspace as a table. Two tabs, **Active**
and **Archived**, split the rows the same way the sidebar's view toggle does,
and `?tab=archived` addresses the archive.

The page re-implements no list rule:

- **Rows**: `useSessions({ crossWorkspace: true })`, cut by tab and ordered by
  `buildConversationSections` in its new `flat` mode (one section, no pinned
  float, folders or date buckets).
- **Filters, sort and saved views**: the shared filter controller, given the
  page's own state owner (`filterState`, persisted in
  `useConversationManagerStore`). Narrowing the table never narrows the
  sidebar, and the sidebar never narrows the table. Saved view definitions stay
  the profile's.
- **Search**: the title ranker, plus the message-content index on request
  (`useChatHistorySearch`).
- **Writes**: `useConversationRowActions` over the routed writers, which bring
  the handoff gate, toasts, Undo and telemetry with them.
- **Shared components**:
  - row menu: `SessionRowMenuItems`, with the desktop hand-offs from `useSessionDesktopHandoffs`;
  - inline rename: `useInlineRename`;
  - bulk bar: `ChannelListBulkActions` with `layout="bar"`;
  - empty states: `ConversationListEmptyState` and `ConversationNarrowedEmptyState`;
  - export dialog;
  - delete confirm;
  - empty-archive dialog.
- **Usage columns** (turns, tokens, cost): `useSessionUsageSummaries`, which
  reads only the rows drawn. Settings → Sessions uses the same hook.

Header sorting maps one to one onto `ConversationSortBy` (title, last activity
newest or oldest, created), so the header and the filter menu's sort section
always agree. Usage columns are not sortable.

Select-all means the whole filtered view, not the page drawn ("Show more" pages
by 100).

The route is registered in all the usual places:

- the navigation catalog (`types/shell/sidebar.ts`, with ⌘K aliases);
- the surface contract: `standalone: "full"`, `companion: "remote"`,
  `offline: "cached-read"`, like the chat itself;
- the full-viewport routes;
- the Go menu, in both TypeScript and Rust.

The chat sidebar stays the place conversations are *used* from. Its ⋯ menu, and the
phone list's, gains "Manage conversations…", which opens the page on the
matching tab.
Settings → Sessions narrows to the agent-runtime view: a manager entry card
with counts, the SDK-bound conversations, and native SDK sessions.

### 2. A user's own send unarchives; background writes do not

When the user sends a message to an archived conversation, it is unarchived and
a toast with Undo says so (`useUnarchiveOnUserTurn`). Bot, scheduler and
connector writes leave the conversation archived: it was archived to stop
asking for attention, and a background turn is not the user coming back to it.

An open archived conversation shows `ArchivedConversationBanner` with
**Unarchive**. The welcome screen's "Continue" never offers an archived
conversation.

### 3. Pins and folders survive the archive, frozen

Archiving clears neither pin nor folder, so unarchiving puts the row back where
it was, losslessly. Inside the archive both are facts, not places:

- The model emits no Pinned section.
- The row menu offers no pin or unpin, no move to folder, no new folder and no
  read state.
- The pin drop zone and manual reorder are off.
- The scope headers offer no "+", no unread pill and no "Mark all read".
- The bulk bar's verbs follow the selection: Archive acts on the selected
  active rows, Unarchive on the selected archived rows, and Pin, Move and read
  state appear only when nothing archived is selected.

The manager's rows still show the pin glyph and folder chip, because they say
where the row returns to.

### 4. The archive's own tools

- **Empty archive** (`EmptyArchiveDialog`):
  - Deletes every archived conversation in scope through `deleteSessionsRouted`
    (Host intent, else `deleteSessionsWithTeardown`).
  - Keeps handed-off rows and says how many it kept.
  - Is reachable from the sidebar's ⋯ menu, the phone drawer and the manager's
    Archived tab.
- **Auto-archive after N days of inactivity**:
  - The setting is `AppSettings.conversationArchive.autoArchiveAfterDays`:
    7, 14, 30, 60 or 90 days; anything else is off. Its sync category is
    desktop-only.
  - The sweep is the `conversation-auto-archive` scheduler maintenance task. It
    runs every 6 hours, carries the tag `system:conversation-archive`, and is
    skipped on a paired client, where the Host owns the sessions.
  - Selection is a pure function (`lib/chat/auto-archive.ts`). It never takes:
    - a pinned, handed-off or IM-bound conversation;
    - an open or running conversation;
    - the project coordinator, or an unresolved project thread;
    - an attached child whose lifecycle is still live.
  - Inactivity is measured by `conversationLastActivityAt`, the same value the
    list's date buckets use.
  - One `AutoArchiveControl` is mounted in Settings → Conversation and on the
    manager's Archived tab.
- **Phone multi-select** with the shared bulk bar (`layout="bar"`).
- **Shortcut** `shell.conversation.toggleArchive` (default
  `Ctrl+Shift+Backspace`, rebindable). It archives or unarchives the focused
  row, otherwise the open conversation, and the row menus show it.

### 5. One writer for archive and delete

`lib/chat/session-archive-writes.ts` owns the routing:

- `setSessionsArchived(ids, archived)` sends a Host intent per id when the
  intent is negotiated, and otherwise writes locally in one bulk write.
- `deleteSessionsRouted(ids)` routes deletes the same way.

`useSessions`, the chat banner, the send path and the empty-archive dialog all
go through it, so no surface archives or deletes without Host routing and
teardown. Unarchive now offers Undo, and Undo of an archive reopens the
conversation that was open.

## Consequences

- One write path and one list model serve three surfaces: the sidebar, the
  phone drawer and the manager. A rule changed in the model changes all three.
- The manager has page-local narrowing and sort, so its state can differ from
  the sidebar's on purpose. Saved views are shared.
- Settings no longer offers conversation management of its own. Anything it
  showed about conversations now opens the manager.
- The sidebar's archive view is lighter than the manager by design: no table,
  no usage columns, no auto-archive control.

## Out of scope

- The inbox list and connector-override settings keep their own archive paths
  for IM conversations (ADR-0009).
- Unarchiving does not reopen attached children that archiving closed. The
  close records no reason, so reopening could revive children closed for
  another reason.
- The phone's bulk bar and the manager's row menu do not create folders. They
  file rows into existing folders, and folder creation stays a sidebar action.

## Verification

- Archive semantics:
  - `lib/chat/session-archive-writes.test.ts`
  - `hooks/chat/use-session-archive-actions.test.ts`
  - `hooks/chat/use-conversation-row-actions.test.ts`
  - `lib/chat/conversation-list-model.test.ts` (the `flat` mode and no Pinned section in the archive)
  - `components/chat/session-row-menu-items.test.tsx`
  - `components/desktop/channel-list-bulk-*.test.tsx`
  - `components/desktop/channel-list.test.tsx` ("inside the archive" and "archive view entry points")
- Manager:
  - `components/conversations/conversation-manager*.test.tsx`
  - `hooks/conversations/use-conversation-manager.test.ts`
  - `stores/conversations/conversation-manager-store.test.ts`
  - `lib/conversations/conversation-manager.test.ts`
  - `app/conversations/page.test.tsx`
- Auto-archive:
  - `lib/chat/auto-archive.test.ts`
  - `lib/chat/auto-archive-schedule.test.ts`
  - `components/conversations/auto-archive-control.test.tsx`
- Route registration:
  - `lib/runtime/surface-contract.test.ts`
  - `lib/shell/full-viewport-routes.test.ts`
  - `lib/desktop/go-menu.test.ts`
  - `lib/desktop/menu-actions.test.ts`
  - `src-tauri/src/menu.rs` tests
