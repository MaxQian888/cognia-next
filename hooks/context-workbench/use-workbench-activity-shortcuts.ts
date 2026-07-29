"use client"

/**
 * Binds `ctrl+1..7` to the workbench's canonical activities.
 *
 * Before this the right-hand workbench had exactly one keyboard affordance —
 * `artifacts.toggleDock` (Cmd/Ctrl+J), which opens and closes the whole thing.
 * Choosing *which* panel to look at was mouse-only, on a rail that has since
 * moved to the far edge of the window.
 *
 * Each chord targets a canonical activity rather than a rail position, so the
 * meaning survives the two faces of the dock (six activities with an artifact
 * in front, three without), a user-reordered rail, and plugin-contributed
 * activities appended to the end. A chord whose activity the mounted workbench
 * does not offer does nothing at all — deliberately, since falling back to a
 * neighbouring panel would make a fixed key mean different things on different
 * surfaces.
 *
 * Mounted once, at the shell, because `revealActiveWorkbenchActivity` resolves
 * against whichever workbench is in front — the chat dock, Canvas' side panels,
 * the workflow or project editor. Registering per host would give the same
 * chord several handlers racing for one keystroke.
 */

import { useAppShortcut } from "@/hooks/shortcuts/use-app-shortcut"
import { revealActiveWorkbenchActivity } from "@/lib/context-workbench/active-context"
import type { ContextActivity } from "@/types/context-workbench"

/**
 * Shortcut id → activity. Keyed by id rather than derived from
 * `CONTEXT_ACTIVITY_RAIL_ORDER` on purpose: that constant is the rail's
 * *default order*, which the user can now reorder, and a binding that followed
 * it would remap every chord when they did.
 */
const ACTIVITY_BY_SHORTCUT: Record<string, ContextActivity> = {
  "workbench.activity.previewRun": "preview-run",
  "workbench.activity.review": "review",
  "workbench.activity.ai": "ai",
  "workbench.activity.comments": "comments",
  "workbench.activity.inspect": "inspect",
  "workbench.activity.workspace": "workspace",
  "workbench.activity.templates": "templates",
}

export function useWorkbenchActivityShortcuts(): void {
  // Fixed set, fixed order — one `useAppShortcut` per entry, so the hook count
  // is stable across renders.
  useActivityShortcut("workbench.activity.previewRun")
  useActivityShortcut("workbench.activity.review")
  useActivityShortcut("workbench.activity.ai")
  useActivityShortcut("workbench.activity.comments")
  useActivityShortcut("workbench.activity.inspect")
  useActivityShortcut("workbench.activity.workspace")
  useActivityShortcut("workbench.activity.templates")
}

function useActivityShortcut(id: keyof typeof ACTIVITY_BY_SHORTCUT & string): void {
  useAppShortcut(id, () => void revealActiveWorkbenchActivity(ACTIVITY_BY_SHORTCUT[id]), {
    preventDefault: true,
    // Monaco binds Ctrl+1..9 to its own commands, and the embedded browser and
    // terminal panels both host text input. Let the focused editor win.
    editorSelectors: [".monaco-editor"],
  })
}

export default useWorkbenchActivityShortcuts
