/** Persisted working set for a real-file project editor surface. */
export interface ProjectEditorSession {
  /** Absolute path of the selected repository root or worktree. */
  rootKey: string
  /** Open files relative to `rootKey`, kept in tab order. */
  openPaths: string[]
  /** Active relative file path, or null when no file is selected. */
  activePath: string | null
  /** Optional persisted resizable layout owned by the rendering surface. */
  layout?: number[]
  /** Preferred project editor engine for surfaces that offer CodeServer. */
  editorMode?: "monaco" | "codeserver"
}
