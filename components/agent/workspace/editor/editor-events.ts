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
