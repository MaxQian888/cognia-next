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
  /**
   * Which code-server trust domain the Pro IDE pane runs in.
   *
   * The two profiles are mutually exclusive by design (ADR-0088 / the managed
   * IDE extension platform): `managed` loads pinned built-ins, the Cognia
   * broker and signed generated proxies; `native` loads user-selected Open VSX
   * extensions in a separate process, port, `user-data-dir` and
   * `extensions-dir`, and never receives broker credentials. Persisted per
   * scope next to `editorMode` because it is the same kind of choice — which
   * editor this surface reopens into — and the two must be restored together.
   *
   * Absent means `managed`, which is also the backend default.
   */
  proIdeProfile?: "managed" | "native"
}
