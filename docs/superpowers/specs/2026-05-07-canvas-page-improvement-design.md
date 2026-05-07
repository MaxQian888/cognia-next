# Canvas Page Improvement Design

## Context

The canvas system is ~95% UI-complete with solid architecture: 3-pane resizable layout, Monaco editor, AI action toolbar, 5-tab side panel, and full i18n/test coverage. The remaining work is visual polish, layout responsiveness, and customization surfacing — not new feature building.

This design brings VS Code (tab+toolbar merge, panel design), Notion (document grouping, context menus), and Linear (minimal chrome, keyboard-first) patterns into the existing architecture without rebuilding it.

## Goals

1. Merge DocumentTabs + ActionToolbar into a single row (reclaim ~40px editor space)
2. Enhance document rail with time-based grouping, pinning, and context menus
3. Polish side panels with badge counts, inlined content, and consistent spacing
4. Add smooth collapse/expand transitions to panels
5. Surface existing features through command palette and context menus
6. Preserve all existing functionality and test coverage

## Non-Goals

- Adding Activity Bar (VS Code-style left icon rail) — GuildRail already serves this role
- Rewriting the resizable panel system — react-resizable-panels works well
- Adding new AI actions or code execution features
- Changing the global TitleBar or StatusBar

---

## Section 1: Unified Toolbar

**File:** `components/canvas/canvas-panel.tsx`

Merge `CanvasDocumentTabs` and `ActionToolbar` into a single `CanvasToolbar` row.

### Layout (single row, h-9)

```
┌──────────────────────────────────────────────────────────┐
│ 📄 tab1  📄 tab2  📄 tab3                        [+] ⚡ ⋯│
└──────────────────────────────────────────────────────────┘
```

- **Left (flex-1, scrollable):** Document tabs with active indicator
- **Right (shrink-0):** New doc button (+) → Command palette trigger (⚡) → More menu (⋯)
- More menu contains: Review, Fix, Improve, Translate (submenu), Explain, Simplify, Expand, Suggest, Save Version, Format (conditional on text type)

### Behavior

- Tabs: same as current `CanvasDocumentTabs` (click to switch, dropdown per tab for rename/duplicate/delete/close)
- Command palette trigger: `Cmd+K` or click the ⚡ button — adds canvas-specific command group (see Section 5)
- Single-document mode: when only 1 doc, hide the tab bar entirely (same as current behavior)
- Format toolbar: shown inside the More dropdown when document type is "text"

### Current → New mapping

| Current                       | New                                          |
| ----------------------------- | -------------------------------------------- |
| 2 rows (tabs + toolbar)       | 1 row (unified)                              |
| 7 visible action buttons      | 1 ⚡ button + More menu                      |
| Format toolbar visible inline | Format actions in More menu (text docs only) |

---

## Section 2: Document Rail Enhancement

**File:** `components/canvas/canvas-document-rail.tsx`

### Layout

```
┌─ Canvas ─────────────────── [+] ─┐
│ 🔍 Search documents…             │
├──────────────────────────────────┤
│ 📌 Pinned (collapsible)          │
│  ├ ⭐ design-spec.md    markdown │
│  └ ⭐ config.json       json     │
├──────────────────────────────────┤
│ 📅 Today                         │
│  ├ 📄 meeting-notes.md  markdown │
│  └ 📄 utils.ts          typescript│
│ 📅 Yesterday  (collapsed)        │
│ 📅 This Week  (collapsed)        │
│ 📅 Older      (collapsed)        │
├──────────────────────────────────┤
│ 🏷 [All] [md] [ts] [py] [json]  │
│ ↕ Sorted by: Updated ↓           │
└──────────────────────────────────┘
```

### Grouping

- Groups: Pinned → Today → Yesterday → This Week → Older
- Each group is a `Collapsible` with expand/collapse toggle
- Groups with 0 items are hidden
- Pinned group is always first and open by default

### Pinning

- Pin/unpin via context menu or hover action
- Pin state stored in `useCanvasLayoutStore` as a `Set<string>` (document IDs), persisted to localStorage alongside layout state
- Pinned documents appear ONLY in the pinned section (not duplicated in time groups)

### Context Menu

Replace the hover X button with a `ContextMenu` (right-click or long-press):

- Rename → opens `RenameDialog`
- Duplicate → clones document
- Export → Markdown / JSON download
- Pin / Unpin → toggle
- Delete → with confirmation

Keep the quick-delete hover X for power users as a secondary affordance.

### Sort & Filter

- Sort toggle: button next to the search bar cycling through Updated ↓ / Name ↑ / Language
- Language filters: move below the document list as compact chips
- Active filter count shown as badge on the filter section trigger

---

## Section 3: Side Panels Enhancement

**File:** `components/canvas/canvas-side-panels.tsx`

### Tab Bar

```
┌─ 💡 3 ─ 📜 12 ─ 💬 2 ─ 👥 ─ ▶ ────┐
```

- Each tab shows icon + badge count (when > 0)
- Badge: small filled circle with number for suggestions pending, versions count, unresolved comments
- Collaboration shows connection status dot (green/grey/red)
- Execution shows no badge

### Inlined Content

| Tab           | Current                   | New                                                                     |
| ------------- | ------------------------- | ----------------------------------------------------------------------- |
| Suggestions   | Host → SuggestionsPanel   | Inline SuggestionsPanel (no Sheet wrapper)                              |
| History       | Host → Button → Sheet     | Inline preview (last 3 versions) + "Open full history" Sheet trigger    |
| Comments      | Host → Button → Sheet     | Inline preview (last 3 unresolved) + "Open full comments" Sheet trigger |
| Collaboration | Host → Button → Sheet     | Inline status card + "Open collaboration" Sheet trigger                 |
| Execution     | Host → CodeExecutionPanel | Inline CodeExecutionPanel (already inline)                              |

### Empty States

Each panel gets a consistent empty state:

- Icon (muted)
- One-line description
- CTA button when applicable

### Spacing

- Tab content: `p-3` consistently across all panels
- Tab trigger: `h-9` with active border-bottom indicator (already done, keep)
- Content scroll: `ScrollArea` with thin scrollbar

---

## Section 4: Layout Polish

**File:** `components/canvas/canvas-shell.tsx`

### Collapse/Expand Transition

- Add CSS transition on panel width when collapsing/expanding
- Current behavior: instant show/hide via conditional render
- New behavior: the `ResizablePanel` stays mounted, width animates to 0 then collapses

### Drag Handle

- Current: default react-resizable-panels handle
- New: VS Code-style — invisible by default, 4px wide hover zone with a 2px accent bar on hover
- The handle should feel like VS Code's split pane divider

### Mobile Shell

- Keep current mobile shell (Sheet overlays) — it works well
- Add a thin bottom toolbar with: command palette trigger, current doc name, more menu

---

## Section 5: Command Palette Integration

**File:** `components/desktop/command-palette.tsx`

Add a `canvas` command group when canvas guild is active:

```
Canvas
  📄 New Document
  🔍 Search Documents…
  ⚡ Review Document
  🐛 Fix Issues
  ✨ Improve Writing
  🌐 Translate Document…
  💡 Generate Suggestions
  💾 Save Version
  📜 Open History
  💬 Open Comments
  ⚙ Canvas Settings…
```

### Behavior

- Actions that require an active document are disabled (greyed out) when no document is open
- Translate opens a sub-menu of target languages
- Canvas Settings navigates to Settings → Canvas tab

---

## Section 6: Customization Surfacing

### Context Menus (new)

| Location      | Trigger                | Actions                                  |
| ------------- | ---------------------- | ---------------------------------------- |
| Document item | Right-click            | Rename, Duplicate, Export, Pin, Delete   |
| Editor area   | Right-click            | AI actions, Save version, Go to settings |
| Tab           | Right-click (existing) | Keep existing + add "Pin"                |

### Settings Quick Access

- In the More menu (⋯): "Canvas Settings…" item → opens Settings → Canvas
- In Command Palette: "Canvas Settings…" item

---

## Files to Modify

| File                                          | Change                                                             |
| --------------------------------------------- | ------------------------------------------------------------------ |
| `components/canvas/canvas-panel.tsx`          | Merge tabs + toolbar into `CanvasToolbar`                          |
| `components/canvas/canvas-document-tabs.tsx`  | Absorbed into the unified toolbar (may keep as internal component) |
| `components/canvas/canvas-document-rail.tsx`  | Grouping, pinning, context menu, sort toggle                       |
| `components/canvas/canvas-side-panels.tsx`    | Badge counts, inlined Suggestions/Execution, empty states          |
| `components/canvas/canvas-shell.tsx`          | Collapse transitions, drag handle polish                           |
| `components/canvas/canvas-shell.test.tsx`     | Update tests for new behavior                                      |
| `components/desktop/command-palette.tsx`      | Add canvas command group                                           |
| `components/desktop/command-palette.test.tsx` | Update tests                                                       |
| `i18n/messages/en.json`                       | New i18n keys                                                      |
| `i18n/messages/zh-CN.json`                    | New i18n keys                                                      |
| `stores/canvas/canvas-layout-store.ts`        | Add pinned docs set (or use metadata on artifact store)            |

## Files NOT Modified

- All `components/ui/` files (shadcn vendored)
- `stores/canvas/canvas-settings-store.ts` (no changes needed)
- `stores/canvas/comment-store.ts` (no changes needed)
- `stores/canvas/keybinding-store.ts` (no changes needed)
- `stores/canvas/chunked-document-store.ts` (no changes needed)
- All `types/canvas/` files (no new types needed)
- All side panel content components (SuggestionsPanel, VersionHistoryPanel, etc.) — only their host wrappers change

---

## Verification

1. `pnpm typecheck` — zero errors
2. `pnpm test` — all existing tests pass; update tests for modified components
3. `pnpm lint` — zero warnings
4. Manual verification in browser:
   - Open canvas guild → verify single-row toolbar
   - Create 3+ documents → verify tab switching, more menu
   - Pin 2 documents → verify pinned section at top
   - Right-click document → verify context menu actions work
   - Switch between side panel tabs → verify badge counts and inlined content
   - Resize panels by dragging handles → verify smooth resize
   - Collapse/expand left and right panels → verify transition animation
   - Press Cmd+K → verify canvas commands appear in palette
   - Resize browser to mobile width → verify mobile shell works
5. `pnpm build` — production build succeeds
