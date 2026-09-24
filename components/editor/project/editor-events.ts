// Shared window-event contract for the project editor. Kept in its own module
// so the orchestrator and the Monaco surface can both import it without a
// circular dependency.

/** Reveal a line/column in the open Monaco surface for `relPath`. */
export const PROJECT_EDITOR_GOTO_EVENT = "project-editor-goto"

export interface ProjectEditorGotoDetail {
  relPath: string
  line: number
  column: number
}

// A goto request survives here until a mounted editor consumes it. The live
// `PROJECT_EDITOR_GOTO_EVENT` only reaches an editor that already mounted —
// on a cold open (terminal link → first file) the event fires while Monaco is
// still loading and would silently drop the requested line. Arming the detail
// before dispatching lets the editor drain it the moment it comes up.
const pendingGotos = new Map<string, { detail: ProjectEditorGotoDetail; armedAt: number }>()

// An arm whose target never opened (failed read, deleted file) must not jump
// a much-later, unrelated open of the same path — expire it.
const PENDING_GOTO_TTL_MS = 15_000

/** Stash a goto until the target file's editor is ready to consume it. */
export function armProjectEditorGoto(detail: ProjectEditorGotoDetail): void {
  pendingGotos.set(detail.relPath, { detail, armedAt: Date.now() })
}

/**
 * Take the pending goto for `relPath`, if any. Consumed on read so a stale
 * arm cannot re-apply on a later, unrelated mount.
 */
export function consumeProjectEditorGoto(relPath: string): ProjectEditorGotoDetail | null {
  const armed = pendingGotos.get(relPath)
  if (armed === undefined) return null
  pendingGotos.delete(relPath)
  if (Date.now() - armed.armedAt > PENDING_GOTO_TTL_MS) return null
  return armed.detail
}
