# Canvas Page Improvement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Polish the canvas page with unified toolbar, enhanced document rail (grouping/pinning/context menus), improved side panels (badges/inlined content), smooth layout transitions, and canvas command palette integration.

**Architecture:** Incremental polish on the existing 3-pane canvas layout. No architectural changes — same component tree, same stores, same data flow. The primary structural change is merging `CanvasDocumentTabs` + `ActionToolbar` into a single row within `CanvasPanel`, and adding a `pinnedDocIds` Set to `useCanvasLayoutStore`.

**Tech Stack:** Next.js 16, React 19, TypeScript, Tailwind v4, shadcn/ui, Zustand, react-resizable-panels, next-intl

**Spec:** `docs/superpowers/specs/2026-05-07-canvas-page-improvement-design.md`

---

## File Map

| File                                            | Action | Responsibility                             |
| ----------------------------------------------- | ------ | ------------------------------------------ |
| `stores/canvas/canvas-layout-store.ts`          | Modify | Add `pinnedDocIds` set + actions           |
| `stores/canvas/canvas-layout-store.test.ts`     | Modify | Tests for pinning                          |
| `components/canvas/canvas-panel.tsx`            | Modify | Merge tabs+toolbar into `CanvasToolbar`    |
| `components/canvas/canvas-document-rail.tsx`    | Modify | Grouping, pinning, context menu, sort      |
| `components/canvas/canvas-side-panels.tsx`      | Modify | Badge counts, inline content, empty states |
| `components/canvas/canvas-side-panels.test.tsx` | Modify | Update tests                               |
| `components/canvas/canvas-shell.tsx`            | Modify | Collapse transitions, drag handle          |
| `components/canvas/canvas-shell.test.tsx`       | Modify | Update tests                               |
| `components/desktop/command-palette.tsx`        | Modify | Canvas command group                       |
| `components/desktop/command-palette.test.tsx`   | Modify | Update tests                               |
| `components/desktop/shell.tsx`                  | Modify | Wire canvasActions to CommandPalette       |
| `app/globals.css`                               | Modify | Drag handle CSS                            |
| `i18n/messages/en.json`                         | Modify | New i18n keys                              |
| `i18n/messages/zh-CN.json`                      | Modify | New i18n keys                              |

---

### Task 1: Add pinnedDocIds to Canvas Layout Store

**Files:**

- Modify: `stores/canvas/canvas-layout-store.ts`
- Modify: `stores/canvas/canvas-layout-store.test.ts`

**Purpose:** Store pinned document IDs in the persisted layout store so pinned state survives reloads.

- [ ] **Step 1: Update the layout store — add pinnedDocIds and actions**

In `stores/canvas/canvas-layout-store.ts`, add to the `CanvasLayoutState` interface:

```ts
pinnedDocIds: Set<string>
pinDocument: (id: string) => void
unpinDocument: (id: string) => void
isPinned: (id: string) => boolean
```

Add to `CANVAS_LAYOUT_DEFAULTS`:

```ts
pinnedDocIds: new Set<string>(),
```

Add actions in the store creator (after `resetLayout`):

```ts
pinDocument: (id) =>
  set((state) => ({
    pinnedDocIds: new Set([...state.pinnedDocIds, id]),
  })),
unpinDocument: (id) =>
  set((state) => {
    const next = new Set(state.pinnedDocIds)
    next.delete(id)
    return { pinnedDocIds: next }
  }),
isPinned: (id) => get().pinnedDocIds.has(id),
```

Update `partialize` to include `pinnedDocIds` (serialized as array):

```ts
partialize: (state) => ({
  // ... existing fields
  pinnedDocIds: [...state.pinnedDocIds],
}),
```

The persist middleware needs a custom `merge` to deserialize the array back to a Set:

```ts
merge: (persisted: unknown, current: CanvasLayoutState) => {
  const p = persisted as Partial<CanvasLayoutState> & { pinnedDocIds?: string[] }
  return {
    ...current,
    ...p,
    pinnedDocIds: new Set(p.pinnedDocIds ?? []),
  }
},
```

Bump `version` from 4 to 5 and update migrate accordingly.

- [ ] **Step 2: Update layout store tests**

In `stores/canvas/canvas-layout-store.test.ts`, add tests:

```ts
describe("pinnedDocIds", () => {
  it("starts empty", () => {
    const { result } = renderHook(() => useCanvasLayoutStore())
    expect(result.current.pinnedDocIds.size).toBe(0)
  })

  it("pins and unpins documents", () => {
    const { result } = renderHook(() => useCanvasLayoutStore())
    act(() => result.current.pinDocument("doc-1"))
    expect(result.current.pinnedDocIds.has("doc-1")).toBe(true)
    act(() => result.current.unpinDocument("doc-1"))
    expect(result.current.pinnedDocIds.has("doc-1")).toBe(false)
  })

  it("isPinned returns correct values", () => {
    const { result } = renderHook(() => useCanvasLayoutStore())
    act(() => result.current.pinDocument("doc-1"))
    expect(result.current.isPinned("doc-1")).toBe(true)
    expect(result.current.isPinned("doc-2")).toBe(false)
  })
})
```

- [ ] **Step 3: Run tests, verify pass**

```bash
pnpm test -- --testPathPattern="canvas-layout-store"
```

- [ ] **Step 4: Commit**

```bash
git add stores/canvas/canvas-layout-store.ts stores/canvas/canvas-layout-store.test.ts
git commit -m "feat(canvas): add pinnedDocIds to canvas layout store"
```

---

### Task 2: Unified CanvasToolbar — merge DocumentTabs + ActionToolbar

**Files:**

- Modify: `components/canvas/canvas-panel.tsx`

**Purpose:** Replace the two-row (tabs + toolbar) layout with a single unified row. Tabs on the left, command palette trigger + More menu on the right.

- [ ] **Step 1: Write the new CanvasToolbar component**

Add a `CanvasToolbar` component inside `canvas-panel.tsx`. It combines tabs (when multiple documents) and action buttons into a single `h-9` row. The import additions needed:

```tsx
import {
  Search,
  Plus,
  FileCode,
  FileText,
  MoreHorizontal,
  Copy,
  Trash2,
  Edit2,
  X,
} from "lucide-react"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area"
```

The component structure:

- **Left (`flex-1`):** When `documents.length > 1`, render horizontal-scrollable tabs inside `Tabs`. Each tab has an icon, title, dropdown (rename/duplicate/delete), and close X button.
- **Right (`shrink-0`):** "+" new doc button → Search icon (triggers `Cmd+K`) → "..." More dropdown with all AI actions, translate submenu, save version, format toolbar (text docs only).
- Always render `RenameDialog` for the inline rename flow.

- [ ] **Step 2: Replace old two-row layout in CanvasPanel**

Remove the `<CanvasDocumentTabs>` call (line ~280) and `<ActionToolbar>` call (line ~309). Replace with:

```tsx
<CanvasToolbar
  documents={documents}
  activeDocumentId={activeId}
  activeDocLanguage={activeDoc?.language ?? "markdown"}
  isText={activeDoc?.type === "text"}
  running={actions.running}
  onSelectDocument={setActive}
  onCloseDocument={(id) => {
    /* existing logic */
  }}
  onCreateDocument={onCreate}
  onRenameDocument={(id, title) => updateDoc(id, { title, updatedAt: new Date() })}
  onDuplicateDocument={(id) => {
    /* existing logic */
  }}
  onDeleteDocument={(id) => {
    remove(id)
    if (activeId === id) setActive(null)
  }}
  onAction={runAction}
  onTriggerSuggestions={triggerSuggestions}
  onSaveVersion={() => activeDoc && saveVersion(activeDoc.id, "manual")}
  onFormat={handleFormat}
/>
```

- [ ] **Step 3: Delete old ActionToolbar and ActionButton**

Remove the `ActionToolbar` function (lines ~360-479) and `ActionButton` function (lines ~487-506). Remove unused `Separator` import.

- [ ] **Step 4: Remove CanvasDocumentTabs import**

`CanvasDocumentTabs` is no longer imported by `canvas-panel.tsx`.

- [ ] **Step 5: Run typecheck and tests**

```bash
pnpm typecheck
pnpm test -- --testPathPattern="canvas-panel|canvas-document-tabs"
```

- [ ] **Step 6: Commit**

```bash
git add components/canvas/canvas-panel.tsx
git commit -m "feat(canvas): merge document tabs and action toolbar into unified CanvasToolbar"
```

---

### Task 3: Enhance Document Rail — grouping, pinning, context menu

**Files:**

- Modify: `components/canvas/canvas-document-rail.tsx`

**Purpose:** Add time-based grouping, pin support, context menu, and sort toggle.

- [ ] **Step 1: Add imports**

```tsx
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Pin, PinOff, ArrowUpDown, ChevronRight, Download, Copy, Edit2, Trash2 } from "lucide-react"
import { useCanvasLayoutStore } from "@/stores/canvas/canvas-layout-store"
import { RenameDialog } from "./rename-dialog"
```

- [ ] **Step 2: Add sort state and grouping logic**

Add state for sort field/order. Read `pinnedDocIds` from layout store. Add `groupByTime()` function that splits documents into Pinned / Today / Yesterday / This Week / Older groups based on `updatedAt`. Add `handleExport()` for markdown download.

- [ ] **Step 3: Add sort toggle UI**

A compact `DropdownMenu` button between the search bar and the document list that cycles through sort options (Updated / Name / Language).

- [ ] **Step 4: Replace flat list with grouped Collapsible sections**

Replace the `<ul>` with grouped `Collapsible` sections. Each section has a trigger (label + count + chevron) and content (document items in a `<ul>`). Each document item is wrapped in `<ContextMenu>` with actions: Rename, Duplicate, Export, Pin/Unpin (toggle), Delete.

- [ ] **Step 5: Add RenameDialog at bottom of component**

Wire up rename state and the `RenameDialog` component.

- [ ] **Step 6: Run typecheck**

```bash
pnpm typecheck
```

- [ ] **Step 7: Commit**

```bash
git add components/canvas/canvas-document-rail.tsx
git commit -m "feat(canvas): enhance document rail with grouping, pinning, and context menus"
```

---

### Task 4: Polish Side Panels — badges, inlined content, empty states

**Files:**

- Modify: `components/canvas/canvas-side-panels.tsx`
- Modify: `components/canvas/canvas-side-panels.test.tsx`

**Purpose:** Add badge counts to tabs, inline Suggestions and Execution panels, unify empty states.

- [ ] **Step 1: Compute badge counts**

In `CanvasSidePanels`, import `useCommentStore` and compute `tabBadges` from artifact store + comment store:

```tsx
const [tabBadges, setTabBadges] = useState<Record<string, number>>({})
useEffect(() => {
  const doc = documents[activeId ?? ""]
  const suggestions = doc?.aiSuggestions ?? []
  const versions = getCanvasVersions(activeId ?? "")
  const comments = getComments(activeId ?? "")
  setTabBadges({
    suggestions: suggestions.filter((s) => s.status === "pending").length,
    history: versions.length,
    comments: comments.filter((c) => c.status !== "resolved").length,
    collaboration: 0,
    execution: 0,
  })
}, [activeId, documents, getCanvasVersions, getComments])
```

- [ ] **Step 2: Update PanelTab to render badge**

Add optional `badge?: number` prop. When `badge > 0`, render a small pill `span` inside the tab trigger showing the count. When `iconOnly`, include the count in the tooltip label.

- [ ] **Step 3: Inline Suggestions panel**

Rewrite `SuggestionsHost` to render `SuggestionsPanel` directly inline (no Sheet wrapper). Show a centered empty state with icon + text when no suggestions exist.

- [ ] **Step 4: Update HistoryHost**

Show the last 3 versions inline as a compact list with auto-save badges, plus an "Open full history" Sheet trigger button at the bottom. Show centered empty state when no versions.

- [ ] **Step 5: Update CommentsHost and CollaborationHost**

Use consistent centered icon + description + button pattern. `CommentsHost` shows comment summary line when comments exist. `CollaborationHost` shows status card + button.

- [ ] **Step 6: Update tests**

Update `canvas-side-panels.test.tsx` assertions for new rendering patterns (inline content, badge elements, empty states).

- [ ] **Step 7: Run typecheck and tests**

```bash
pnpm typecheck
pnpm test -- --testPathPattern="canvas-side-panels"
```

- [ ] **Step 8: Commit**

```bash
git add components/canvas/canvas-side-panels.tsx components/canvas/canvas-side-panels.test.tsx
git commit -m "feat(canvas): add badge counts, inline content, and unified empty states to side panels"
```

---

### Task 5: Layout Polish — collapse transitions and drag handles

**Files:**

- Modify: `components/canvas/canvas-shell.tsx`
- Modify: `components/canvas/canvas-shell.test.tsx`
- Modify: `app/globals.css`

**Purpose:** Smooth collapse/expand via react-resizable-panels `collapsible` prop, VS Code-style drag handle styling.

- [ ] **Step 1: Use react-resizable-panels collapsible prop**

Replace conditional rendering with `collapsible` + `collapsedSize={0}` on left and right `ResizablePanel`. The panels are always mounted. Add `transition-opacity duration-200` + `opacity-0` when collapsed.

- [ ] **Step 2: Remove floating expand buttons**

Since collapsible panels provide their own expand mechanism via the handle, remove the floating expand buttons.

- [ ] **Step 3: Add drag handle CSS**

In `app/globals.css`:

```css
[data-panel-group] > [data-resize-handle] {
  @apply bg-border/0 transition-colors duration-150;
  width: 4px;
}
[data-panel-group] > [data-resize-handle]:hover,
[data-panel-group] > [data-resize-handle][data-resize-handle-active] {
  @apply bg-primary/30;
}
```

- [ ] **Step 4: Update shell tests**

Update assertions: no floating expand buttons; panels always in DOM; collapsed panels have `collapsedSize={0}`.

- [ ] **Step 5: Run tests and typecheck**

```bash
pnpm test -- --testPathPattern="canvas-shell"
pnpm typecheck
```

- [ ] **Step 6: Commit**

```bash
git add components/canvas/canvas-shell.tsx components/canvas/canvas-shell.test.tsx app/globals.css
git commit -m "feat(canvas): add collapse transitions and VS Code-style drag handles"
```

---

### Task 6: Canvas Command Palette Integration

**Files:**

- Modify: `components/desktop/command-palette.tsx`
- Modify: `components/desktop/command-palette.test.tsx`
- Modify: `components/desktop/shell.tsx`

**Purpose:** Add "Canvas" command group to the existing command palette.

- [ ] **Step 1: Extend CommandPalette props**

Add optional `canvasActions` prop with `enabled`, `hasActiveDocument`, and handler functions for all canvas actions.

- [ ] **Step 2: Add Canvas command group**

When `canvasActions?.enabled`, render a `CommandGroup heading={t("groups.canvas")}` with: New Document, Review, Fix, Improve, Canvas Settings (only when `hasActiveDocument`).

- [ ] **Step 3: Wire in DiscordShell**

In `components/desktop/shell.tsx`, pass `canvasActions` when `isCanvasGuild`. Handlers dispatch custom events or call store actions directly.

- [ ] **Step 4: Run typecheck and tests**

```bash
pnpm typecheck
pnpm test -- --testPathPattern="command-palette"
```

- [ ] **Step 5: Commit**

```bash
git add components/desktop/command-palette.tsx components/desktop/command-palette.test.tsx components/desktop/shell.tsx
git commit -m "feat(canvas): add canvas command group to command palette"
```

---

### Task 7: i18n Keys

**Files:**

- Modify: `i18n/messages/en.json`
- Modify: `i18n/messages/zh-CN.json`

**Purpose:** Add all new i18n keys.

- [ ] **Step 1: Add canvas section keys**

English: `pinned`, `today`, `yesterday`, `thisWeek`, `older`, `pin`, `unpin`, `export`, `commandPalette`, `more`, `sortByUpdated`, `sortByName`, `sortByLanguage`

Chinese: `已置顶`, `今天`, `昨天`, `本周`, `更早`, `置顶`, `取消置顶`, `导出`, `命令面板`, `更多操作`, `更新时间`, `名称`, `语言`

- [ ] **Step 2: Add canvas.panels empty state keys**

English: `suggestionsEmpty`, `historyEmpty`, `commentsEmpty`, `commentsSummary`, `collabEmpty`, `executionEmpty`

Chinese: Descriptive empty state messages.

- [ ] **Step 3: Add desktop.commandPalette.groups.canvas**

English: `"Canvas"`, Chinese: `"画布"`

- [ ] **Step 4: Commit**

```bash
git add i18n/messages/en.json i18n/messages/zh-CN.json
git commit -m "feat(canvas): add i18n keys for canvas improvements"
```

---

### Task 8: Final Verification

- [ ] **Step 1: Run full test suite** — `pnpm test` (all pass)
- [ ] **Step 2: Run typecheck** — `pnpm typecheck` (zero errors)
- [ ] **Step 3: Run lint** — `pnpm lint` (zero warnings)
- [ ] **Step 4: Run build** — `pnpm build` (success)
- [ ] **Step 5: Visual check** — `pnpm dev`, open canvas guild, verify per design spec
