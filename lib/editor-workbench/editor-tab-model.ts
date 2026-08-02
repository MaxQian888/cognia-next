/**
 * Preview / pinned tab semantics, as VS Code defines them.
 *
 * A *preview* tab is the one italic tab a group is allowed to hold. Opening
 * another file in preview mode reuses that single slot: the previous preview is
 * evicted so browsing a tree does not bury the user under twenty tabs. A
 * *pinned* tab is permanent — it was opened deliberately (double-click, "keep
 * open") or the user started editing it, and nothing evicts it.
 *
 * Kept pure and free of React so the project editor, the chat dock's workspace
 * and the unified dock's editor panels can all share one definition of "what
 * does opening this file do to the tab strip" instead of each inventing its own.
 */

export type EditorTabMode = "preview" | "pinned"

export interface EditorTabState {
  /** relPath of the group's single preview tab, or `null` when it has none. */
  previewPath: string | null
}

export const EMPTY_EDITOR_TAB_STATE: EditorTabState = { previewPath: null }

/**
 * What opening `relPath` does to the strip.
 *  - `activate` — the tab already exists; just focus it.
 *  - `insert`   — a new tab is added and nothing is evicted.
 *  - `replace`  — a new preview tab takes the preview slot, evicting its holder.
 */
export type EditorTabOutcome = "activate" | "insert" | "replace"

export interface EditorTabRequest {
  relPath: string
  /** How the caller asked for it. A tree single-click is `preview`. */
  mode: EditorTabMode
  /** Whether the file already has a tab. */
  isOpen: boolean
}

export interface EditorTabTransition {
  outcome: EditorTabOutcome
  /** Tab the caller must close because the preview slot changed hands. */
  evicted: string | null
  state: EditorTabState
}

/** Resolve one open request against the current preview slot. */
export function resolveTabIntent(
  state: EditorTabState,
  request: EditorTabRequest
): EditorTabTransition {
  const { relPath, mode, isOpen } = request

  if (isOpen) {
    // Re-opening an existing tab never evicts and never demotes it. Asking for
    // it in pinned mode is how a double-click promotes the current preview.
    const previewPath =
      mode === "pinned" && state.previewPath === relPath ? null : state.previewPath
    return { outcome: "activate", evicted: null, state: { previewPath } }
  }

  if (mode === "pinned") {
    return { outcome: "insert", evicted: null, state }
  }

  const evicted =
    state.previewPath !== null && state.previewPath !== relPath ? state.previewPath : null
  return {
    outcome: evicted ? "replace" : "insert",
    evicted,
    state: { previewPath: relPath },
  }
}

/** Promote a tab to permanent. A no-op for tabs that are already pinned. */
export function pinTab(state: EditorTabState, relPath: string): EditorTabState {
  return state.previewPath === relPath ? EMPTY_EDITOR_TAB_STATE : state
}

/** Forget a closed tab. Only the preview slot is tracked, so this is narrow. */
export function forgetTab(state: EditorTabState, relPath: string): EditorTabState {
  return state.previewPath === relPath ? EMPTY_EDITOR_TAB_STATE : state
}

/** Carry the preview slot across a rename or a move. */
export function renameTab(state: EditorTabState, from: string, to: string): EditorTabState {
  if (state.previewPath === null) return state
  if (state.previewPath === from) return { previewPath: to }
  // Directory renames migrate every descendant path.
  if (state.previewPath.startsWith(`${from}/`)) {
    return { previewPath: `${to}${state.previewPath.slice(from.length)}` }
  }
  return state
}

/** Is this tab the group's preview tab? */
export function isPreviewTab(state: EditorTabState, relPath: string): boolean {
  return state.previewPath === relPath
}
