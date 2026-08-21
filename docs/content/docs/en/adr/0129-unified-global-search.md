---
title: ADR-0129 — Unified global search
description: One search surface (⌘K) behind one open seam, one rebindable shortcut and one provider registry — conversations by title, message history with role / date / archive filters, commands, pages, settings, people, and the app's libraries — replacing six palettes and three ⌘K listeners.
---

# ADR-0129 — Unified global search

| Field     | Value                                                                                                                                                                                                                                                                                                                             |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status    | Accepted                                                                                                                                                                                                                                                                                                                          |
| Date      | 2026-08-16                                                                                                                                                                                                                                                                                                                        |
| Builds on | ADR-0099 — Chat-history search engine (`lib/chat/search/`); ADR-0094 — Conversation anchors and cross-session jump; ADR-0098 — Persistent workbench rail; ADR-0108 — Codex-inspired desktop workflows (title-bar pill, `command-palette-request` seam); ADR-0059 — Host profiles / capability gates                                |
| Scope     | `lib/global-search/**`, `hooks/global-search/`, `components/global-search/`, `lib/shell/command-palette-request.ts`, `lib/shortcuts/app-catalog.ts`, `lib/chat/search/engine.ts` (filters), thin adapters `components/desktop/command-palette.tsx` + `components/mobile/home/mobile-command-palette.tsx`, `components/inbox/inbox-shell.tsx`, `components/settings/settings-shell.tsx`, `components/mobile/shell/mobile-shell-wrapper.tsx`, `lib/desktop/menu-actions.ts`, `lib/plugin/contracts/plugin-points.ts` |

## Context

An audit of every "search" entry in the three shells found no unified registry — six independent cmdk `CommandDialog` palettes, three find bars and half a dozen inline inputs, opened by four different mechanisms:

- **⌘/Ctrl+K was claimed three times at once.** The desktop `CommandPalette` (always mounted), `InboxCommandPalette` (mounted twice inside `inbox-shell.tsx`) and `settings-shell.tsx` each had a raw `window` keydown listener. On `/inbox` and `/settings` two dialogs opened on one keystroke, in listener-registration order. None of them was on the rebindable shortcut catalog (`lib/shortcuts/app-catalog.ts`), so ⌘K could not be rebound or conflict-checked.
- **The native menu's palette action was broken on macOS.** `lib/desktop/menu-actions.ts:commandPaletteAction` forged a `Ctrl+K` keystroke while the palette required `⌘K` on a Mac; `title-bar-workspace.tsx` had already hit the same bug and switched to `requestCommandPalette()`, the menu action never had.
- **Desktop and mobile palettes were ~80 % copy-paste**, but each lacked groups the other had (mobile: no navigation, workbench panels, workspaces, plugin actions, settings sub-items, no keyboard trigger; desktop: no workflows). Both hard-coded a 12-session "recent" slice, filtered sessions by `title + id` substring only, and knew nothing about archived conversations, roles or dates.
- **Message search existed but was one flat group.** ADR-0099's engine (`searchChatHistory`) is a solid indexed substring engine with absolute scoring and branch de-duplication, but the palette exposed none of its query shape (workspace, archived, per-session collapse) and the engine had no role / date filters.
- **A dozen searchable entity stores** (memories, skills, workflows, templates, scheduled tasks, plugins, MCP servers, platform-bound inbox conversations, workbench panels, settings sections and controls) were reachable only from their own pages.
- **The empty state was dead.** An open palette with no query showed the same static lists as with a query — no recent searches, no recently opened items.

## Decision

### 1. One dialog, one seam, one shortcut

`components/global-search/global-search-dialog.tsx` is the single global search surface for desktop and mobile. It:

- registers **`app.commandPalette.toggle`** (`ctrl+k`, `allowInEditable`, plugin command id `command-palette.toggle`) on the app-scope shortcut catalog — first-match-wins in the shared dispatcher, rebindable in Settings → Shortcuts, no private `window` listener;
- subscribes to the existing DOM seam `lib/shell/command-palette-request.ts`, whose detail grows from `{ query? }` to **`{ query?, scope? }`** so any surface can open the dialog pre-scoped (the conversation rail's "Search everywhere", the settings shell's finder button, the native menu, the title-bar pill);
- accepts an optional controlled `open` / `onOpenChange` pair so the mobile home shell can keep driving it from its search bar and quick-action grid, plus a `host` adapter (`onOpenSettings`, `onNewChat?`, `onSelectSession?`) for the two shell-specific behaviours.

**Two mobile mounts, never both at once.** `AppShellMobile` renders only on `/`, so a single mount there would leave ⌘K and the seam dead on `/settings`, `/inbox` and `/me/*` — routes the old per-shell palettes did cover. `components/mobile/shell/mobile-global-search-host.tsx` mounts the dialog from `MobileShellWrapper` (which wraps every mobile route) and returns `null` on `/`, where the home shell's picker- and drawer-aware `MobileCommandPalette` owns it.

`components/desktop/command-palette.tsx` and `components/mobile/home/mobile-command-palette.tsx` become thin adapters that keep their public props so `desktop-app-shell.tsx` and `app-shell-mobile.tsx` do not change. `InboxCommandPalette` and `SettingsFinder` are removed: their sources are built-in providers below, and their shells stop listening for ⌘K. `commandPaletteAction()` calls `requestCommandPalette()`.

### 2. Provider registry — `lib/global-search/`

| Module              | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types.ts`          | `GlobalSearchKind` (18 kinds), `GlobalSearchScope` (`all · chats · messages · commands · pages · people · library`) with the fixed `KIND_SCOPES` map, `GlobalSearchItem` (title / subtitle with highlight positions, `meta`, `icon` = lucide component or `avatar` subject, `score`, `timestamp`, `extra` flags, `action`), the discriminated `GlobalSearchAction` union, `GlobalSearchProvider` (`kind`, `search()`, optional `suggest()` for the empty query), `GlobalSearchContext`. |
| `query-parser.ts`   | `parseGlobalSearchQuery(raw)` — leading `>` (commands) / `@` (people) prefixes; `in:<kind|scope>`, `from:user|assistant`, `is:archived`, `before:`/`after:` (`YYYY-MM-DD`, `7d`, `2w`, `3m`), `workspace:current|all`, `title:` tokens; the residual free text is the needle. Unknown tokens stay in the text — the parser never eats a word the user meant literally.                                                                                                                       |
| `registry.ts`       | `registerGlobalSearchProvider` / `unregister` / `listGlobalSearchProviders` / `subscribeGlobalSearchProviders`. Built-ins register once through `providers/index.ts`; plugins get the same seam (`GlobalSearchProvider` is host-agnostic data + a `callback` action).                                                                                                                                                                                                                       |
| `scoring.ts`        | `scoreTitleMatch(query, text)` = `titleMatchRank` (prefix / word-start / anywhere) blended with `fuzzyMatch` positions and a recency half-life; every provider hands the engine a `score ∈ [0, 1]` so groups can be ordered by their best hit in the *All* scope.                                                                                                                                                                                                                              |
| `cache.ts`          | `createSearchCache(loader, ttlMs)` — a per-provider memo with TTL, cleared by `invalidateGlobalSearchCaches()` on every dialog open. Async providers read Dexie through it, so a keystroke never re-scans a table.                                                                                                                                                                                                                                                                             |
| `recents.ts`        | Recent queries (last 8) and recently opened items (last 12) in `localStorage`, keyed per host, with `record*` / `list*` / `clear*` and a subscribe hook for the empty state.                                                                                                                                                                                                                                                                                                                 |
| `engine.ts`         | `runGlobalSearch(parsed, ctx, { limit, signal })` — resolves the providers for the scope (or the `in:` filter), runs them concurrently with a per-provider budget, tolerates provider failures (reported per group, never fatal), and returns `{ groups, coverage, tookMs }` where each group is `{ kind, items, total, truncated }`. Group order in *All* is a stable kind priority list re-ranked by best score; scoped tabs return one deep list with "show more".                            |

**Built-in providers** (`lib/global-search/providers/`): `sessions` (title + id, exposure-filtered through `isSessionExposed(…, "global-search")`, archived / workspace / kind aware, recency-ranked, `suggest` = most recent), `messages` (wraps `searchChatHistory` with the new `roles` / `after` / `before` filters, `collapseBySession` in the *Chats* scope, coverage → `indexing` / `partial`), `navigation` (sidebar catalog + DM / Canvas), `settings` (reachable `SETTINGS_NAV` sections + `SETTING_CONTROLS` → `/settings?section=&focus=`), `actions` (new chat, export, clear, theme, open folder, check updates, skill recorder — `command` actions the dialog host resolves), `characters`, `teams`, `workspaces`, `workflows`, `skills`, `memories`, `templates`, `scheduled-tasks`, `plugins`, `plugin-actions` (quick-action registry), `mcp-servers`, `inbox` (platform-bound sessions → `/inbox/c?key=`), `workbench-panels`.

### 3. Chat search: titles *and* content, with filters

`ChatSearchQuery` gains `roles?`, `after?`, `before?` (applied at the session-metadata step so the corpus scan is untouched; over-fetch is widened when a filter is active). The *Chats* scope shows two groups — **Conversations** (title hits) and **Conversations mentioning …** (message hits collapsed per session) — while the *Messages* scope is the deep, un-collapsed list with role badge, relative time, archived / branch-copy chips and highlighted snippet. Selecting a message hit still goes through `jumpToSessionMessage` (ADR-0094) and reports a failed landing.

### 4. Dialog anatomy

`CommandDialog` with `shouldFilter={false}` (ranking is the engine's job): a scope tab row (`Tab` / `Shift+Tab` cycle, `Alt+1…7` jump), the input with active-filter chips (removable), grouped results with per-kind rows (`global-search-result-row.tsx`), a "Show all N in <scope>" trailer per group in *All*, an empty state (recent searches, recently opened, suggestions), and a footer with keyboard hints, hit count, elapsed time and the coverage note ("still indexing older history"). Mobile renders the same tree full-height.

### 5. Out of scope / kept separate

Editor-local palettes stay: the workflow editor's node palette and spotlight (`components/workflow/editor/`), the canvas inline command, the workbench `PanelQuickSwitch` (its own rebindable chord), the in-conversation find bar (`chat.search.toggle`), and the web-search `/search` page (a different product: BYOK web answers).

The workflow editor's palette keeps ⌘K, but no longer on a raw listener. It registers `workflow.commandPalette.toggle` on the same dispatcher (`hooks/workflow/use-workflow-command-palette-shortcut.ts`) and publishes `view.workflowEditor` while the canvas is mounted; `app.commandPalette.toggle` carries the exact negation `!view.workflowEditor`. Same chord, opposite `when` ⇒ the dispatcher's first-match-wins loop can only ever fire one of them, `findAppConflict` does not report the pair, and both rows are rebindable in Settings → Shortcuts. Global search stays reachable inside the editor from the title-bar search pill, which goes through `requestCommandPalette()`.

## Consequences

- One keystroke opens exactly one dialog on every route; the binding is visible and rebindable in Settings → Shortcuts.
- Every entity family is one provider file away from the palette; the mobile palette gains 14 groups it never had, the desktop one gains workflows, skills, memories, templates, scheduled tasks, plugins, MCP servers, inbox conversations and settings controls.
- Removed: `components/inbox/inbox-command-palette.tsx`, `components/settings/finder/settings-finder.tsx`, the desktop palette's 500-line body, the mobile palette's copy of it, and the `desktop.commandPalette` / `mobile.search` / `inbox.commandPalette` message trees plus the finder's own chrome strings (replaced by `globalSearch.*`; `settings.finder.controls.*` stays as the control labels).
- Follow-ups: a `*grams` session prefilter if the resident corpus cap is reached (ADR-0099 phase B); persist "recently opened" server-side for the companion profile.

## Amendment (2026-08-21) — the conversation list is a search surface too

The sidebar conversation list was audited against this ADR's own premise — that
finding a conversation should not depend on where you happen to be standing —
and eight ways it broke that premise were fixed. The list is now the second
search surface governed here; the ranker is literally the same function.

### 6. Views replace filter presets

`ConversationSidebarSettings.filterPresets` could only save the quick filters,
so the views people wanted — "unread first", "everything I made this week",
"search my whole account" — were unrepresentable: each needs a sort, a grouping
or a search reach as well. A **view** (`lib/chat/conversation-views.ts`,
`ConversationView`) pins any of four dimensions: `filters`, `sortBy`, `groupBy`,
`search`.

It is a **partial overlay, not a snapshot**: an absent dimension means "leave the
current value alone". That is what makes every stored preset a valid view with
no migration (a preset is a view that pins only its filters), and what stops
"unread first" from silently discarding the grouping the user had chosen.

Storage is split along the axis it already was: definitions live in the settings
blob so they follow the profile, while **which view is active**
(`activeConversationViewId`) is UI-store layout state, so a phone and a desktop
can sit in different views. Applying a view therefore writes to both, which is
why that write lives in `useConversationFilterController` rather than in each
surface.

The chip says `name · modified` once any pinned dimension drifts
(`conversationViewDrift`), and offers *reset to view* / *update this view*.
Inferring the active view by comparing filters — the old behaviour — lost the
view the instant anything was nudged, which is also why "update this view" could
not be offered: nothing knew which view was meant.

Three built-ins ship as code, not data (**Unread**, **Recently created**,
**Search everything**): they are the discovery path for vocabulary nobody goes
looking for in a menu. They are hidden rather than deleted, and a stored row
claiming a built-in id is ignored so the built-in stays reachable.

### 7. Search reach: one control, three axes

Whether the sidebar could find a conversation used to depend on three unrelated
things — archived rows only by switching the whole list to the archived view,
another workspace's rows only when the *grouping* happened to be `"workspace"`,
and message content from a settings toggle. `ConversationSearchOptions`
(`lib/chat/conversation-search-scope.ts`) owns all three, a view can carry them,
and `ConversationSearchScopeControl` sits beside the field it governs.

- `needsCrossWorkspaceSessions(groupBy, search)` decides the `useSessions`
  subscription, so "can I find this chat?" no longer depends on how the list is
  grouped.
- `includeArchived` applies **only while a query is present**. Browsing archived
  conversations stays the view toggle's job, so the two controls never describe
  the same thing.
- The legacy `searchScope` enum folds into `content` through the resolver; the
  object wins in both directions so a downgrade round-trip cannot resurrect a
  setting the user has since changed.

### 8. The same ranker, and the same honesty about async

`buildConversationSections` takes an injected `scoreTitle`
(`ConversationTitleScorer`) and `hooks/chat/use-conversation-list-model.ts`
supplies `scoreTitleMatch` — so "dply" finds "deploy" in the sidebar, and the
same query orders its hits the same way in both surfaces. Injection rather than
import: `lib/global-search/scoring.ts` already imports the model's
`titleMatchRank`, and the reverse edge would close a cycle.

Content hits resolve a beat after title hits. Neither surface may claim "no
results for X" while `contentSearch.loading` — it reads as a miss and then
contradicts itself — and a one-character query now says so rather than silently
degrading to title-only (the message index needs `CONTENT_SEARCH_MIN_QUERY`).

### 9. Dates follow the sort axis

Buckets used to come from `lastMessageAt` whatever the sort was, so "by date
created" produced a list bucketed by last activity, and `oldest` ran the rows
backwards under forward headers. `resolveConversationTimeBasis(sortBy)` now
decides the timestamp for the buckets, the headers and the activity filter
alike; `oldest` reverses the bucket order; and `title` / `unread` — which have
no date axis at all — render one flat section rather than headers that do not
explain the list. (Alphabetical headers are not an option: `localeCompare`
orders zh-CN titles, but no single leading character names the group without a
pinyin table.)

### 10. Team is a real grouping axis

`groupBy: "team"` used to emit plain date buckets and rely on the desktop guild
rail having filtered the list — which left the mobile list, with no rail, showing
"grouped by team" over a list that was not. `ConversationGroupAxis` gains
`"team"`; the rail becomes a way to *jump* to a team's section, and narrowing to
one team is the existing `teamIds` facet's job.

### 11. Holding the list still while it is read

The list is a live query ordered by activity, so a background conversation slides
rows under the cursor — and under date bucketing, out of the section entirely.
`lib/chat/conversation-order-freeze.ts` + `hooks/chat/use-conversation-order-freeze.ts`
hold the *order* (and section membership) while the pointer is over the list or
it is scrolled, releasing on the conjunction. Additions and removals are never
held: freezing insertions would fight the new-conversation reveal, and holding a
deleted row would leave one that opens nothing. A pill reports how many rows are
waiting and applies them at once.

`@tanstack/react-virtual` windows only long **flat, un-draggable** sections
(search results, `title` / `unread` sorts, past 200 rows) — the only place with
no sticky group header to pin and no sortable context whose items must stay in
the DOM.

### 12. Smaller corrections

- `modelFolders` was doing two jobs: hiding folder *grouping* in the archived
  view and starving the folder *facet* of its options, so an archived-view chip
  rendered a raw folder id. Split.
- `visibleCount` (rows on screen) now feeds the "showing N of M" chip, while
  `filteredCount` keeps its meaning for the empty state — collapsing every group
  is not "your filters matched nothing".
- Settings → Conversation loses `sortBy` / `groupBy` / `searchScope`. That card
  decides how a row *looks*; a settings page is the wrong place to answer "where
  did my conversation go", and a view can carry these where a settings page
  cannot.
- `mobile.home.ungroupedWorkspace` / `ungroupedAgent` never existed in either
  locale, so the mobile ungrouped header rendered its own key. Added, along with
  `ungroupedTeam`.

**Scope added:** `lib/chat/{conversation-views,conversation-search-scope,conversation-order-freeze,conversation-group-axis}.ts`,
`lib/chat/conversation-{list-model,filters}.ts`, `hooks/chat/{use-conversation-list-model,use-conversation-filter-controller,use-conversation-order-freeze}.ts`,
`components/chat/conversation-filter-controls.tsx`, `components/desktop/{channel-list,session-row}.tsx`,
`components/mobile/shell/mobile-channel-list.tsx`, `components/settings/conversation/conversation-sidebar-card.tsx`,
`stores/ui/ui-store.ts`, `packages/agent-config-types/src/index.ts`.
