// Cross-surface bridge so terminal path-links can open in the live project
// editor (editable + LSP) instead of the read-only file viewer. The Agent Team
// project editor registers an opener keyed by its root; the terminal asks this
// bridge to open a clicked absolute path and only falls back to the read-only
// `file-viewer-dialog` when no editor is rooted at that path.
//
// The bridge is also the engine-agnostic seam for reading *back* what the user
// is looking at, so callers (the `read_active_editor` agent tool, the plugin
// editor API) never have to know whether Monaco or code-server is mounted.

/** One diagnostic in an {@link ActiveEditorContext} snapshot. */
export interface ActiveEditorDiagnostic {
  message: string
  severity: "error" | "warning" | "info" | "hint"
  /** 1-based line/column of the diagnostic's start. */
  line: number
  column: number
}

/**
 * Live active-editor context: "what is the user looking at". Whole file bodies
 * are deliberately excluded — callers read files with their own tools.
 *
 * This is the single canonical shape both engines produce. It originated as
 * code-server's wire payload; Monaco assembles the same fields from its model,
 * selection and markers. Keeping one shape is what lets the PII gate and the
 * tool contract downstream stay engine-blind — if the two ever diverge, every
 * consumer has to learn which engine it is talking to.
 */
export interface ActiveEditorContext {
  /** Absolute path of the focused file editor, or null when none is focused. */
  path: string | null
  /** 1-based selection range, or null when nothing is focused. */
  selection: { startLine: number; startColumn: number; endLine: number; endColumn: number } | null
  /** The selected text, or null for an empty selection / no editor. */
  selectedText: string | null
  diagnostics: ActiveEditorDiagnostic[]
  /** Absolute paths of the open file editors. */
  openEditors: string[]
}

export interface ProjectEditorOpener {
  /** Absolute root the editor is mounted at. */
  root: string
  /** Open a file (path relative to `root`), optionally revealing line/column. */
  open: (relPath: string, line?: number, column?: number) => void
  /**
   * Reflect an agent's just-written file (path relative to `root`) as an
   * undo-able in-editor edit rather than a plain open. Optional: editors that
   * can't do this (the Monaco workbench relies on its own external-change
   * reload; the dormant dock reveal opener only queues a reveal) omit it, and
   * `reflectEditInProjectEditor` falls back to `open`.
   */
  applyEdit?: (relPath: string, line?: number, column?: number) => void
  /**
   * Read what the user is currently looking at in this editor. Optional: the
   * dormant dock reveal opener has no editor behind it and omits this, which is
   * precisely why reads resolve through {@link resolveReadOpener} instead of the
   * write-side resolution — see the note there.
   */
  readActive?: () => Promise<ActiveEditorContext>
}

const openers = new Set<ProjectEditorOpener>()
let pendingOpen: { absolutePath: string; line?: number; column?: number } | null = null
const activeEditorListeners = new Set<() => void>()

/**
 * Subscribe to "what the user is looking at may have changed". Fires when an
 * editor mounts or unmounts, and whenever a mounted editor reports a change via
 * {@link notifyActiveEditorChanged}. Listeners re-read through
 * {@link readActiveFromProjectEditor} — the signal carries no payload because
 * the two engines learn about changes by different routes and only the reader
 * knows which of them is authoritative right now.
 */
export function subscribeActiveEditor(listener: () => void): () => void {
  activeEditorListeners.add(listener)
  return () => {
    activeEditorListeners.delete(listener)
  }
}

/** Tell subscribers the active editor changed. Safe to call from any engine. */
export function notifyActiveEditorChanged(): void {
  for (const listener of [...activeEditorListeners]) listener()
}

/** Register a live project-editor opener. Returns an unregister disposer. */
export function registerProjectEditorOpener(opener: ProjectEditorOpener): () => void {
  openers.add(opener)
  if (
    pendingOpen &&
    openInProjectEditor(pendingOpen.absolutePath, pendingOpen.line, pendingOpen.column)
  ) {
    pendingOpen = null
  }
  notifyActiveEditorChanged()
  return () => {
    openers.delete(opener)
    notifyActiveEditorChanged()
  }
}

const normalizePath = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "")

/**
 * Resolve the project editor rooted at (or above) `absolutePath` plus the path
 * relative to that root. Picks the deepest matching root for nested worktrees,
 * and — for equal roots — the latest registration: a dormant dock reveal opener
 * mounts before the live Monaco/code-server editor, so once the real editor is
 * present it must receive line/column-aware jumps directly.
 */
function resolveOpener(absolutePath: string): { opener: ProjectEditorOpener; rel: string } | null {
  let best: ProjectEditorOpener | null = null
  let bestBase = ""
  const normalizedPath = normalizePath(absolutePath)
  for (const o of openers) {
    const base = normalizePath(o.root)
    if (normalizedPath === base || normalizedPath.startsWith(`${base}/`)) {
      if (!best || base.length >= bestBase.length) {
        best = o
        bestBase = base
      }
    }
  }
  if (!best) return null
  const rel = normalizedPath === bestBase ? "" : normalizedPath.slice(bestBase.length + 1)
  if (!rel) return null
  return { opener: best, rel }
}

/**
 * Route an absolute path to the project editor rooted at (or above) it. Returns
 * true when an editor handled it, false when the caller should fall back to the
 * read-only viewer.
 */
export function openInProjectEditor(absolutePath: string, line?: number, column?: number): boolean {
  const resolved = resolveOpener(absolutePath)
  if (!resolved) return false
  resolved.opener.open(resolved.rel, line, column)
  return true
}

/**
 * Like {@link openInProjectEditor} but for an agent's just-written file: routes
 * to the editor's `applyEdit` (undo-able live reflect) when it has one, else
 * falls back to a plain `open`. Returns false when no editor is rooted there.
 */
export function reflectEditInProjectEditor(
  absolutePath: string,
  line?: number,
  column?: number
): boolean {
  const resolved = resolveOpener(absolutePath)
  if (!resolved) return false
  const { opener, rel } = resolved
  if (opener.applyEdit) opener.applyEdit(rel, line, column)
  else opener.open(rel, line, column)
  return true
}

/**
 * Resolve the editor that can answer a *read* for `root`.
 *
 * Deliberately not `resolveOpener`, on two counts:
 *
 *  - that one keys off an absolute **file** path and rejects a bare root
 *    (`rel` comes back empty), whereas a read is asked per project root;
 *  - that one picks the latest registration for equal roots, but the latest is
 *    often the dormant dock reveal opener, which has no editor behind it and no
 *    `readActive`. Picking it would make reads fail whenever a real editor was
 *    also mounted — the exact case that must succeed.
 *
 * So: deepest matching root, and only among registrations that can actually
 * read. Ties still go to the latest registration, which is the live editor.
 */
function resolveReadOpener(root?: string): ProjectEditorOpener | null {
  // No root asked for: the caller (a plugin, say) has no reason to know project
  // roots and just wants whatever the user is in. Latest readable registration
  // wins, which is the most recently mounted editor.
  if (root === undefined) {
    let latest: ProjectEditorOpener | null = null
    for (const o of openers) if (o.readActive) latest = o
    return latest
  }

  let best: ProjectEditorOpener | null = null
  let bestBase = ""
  const normalizedRoot = normalizePath(root)
  for (const o of openers) {
    if (!o.readActive) continue
    const base = normalizePath(o.root)
    if (normalizedRoot === base || normalizedRoot.startsWith(`${base}/`)) {
      if (!best || base.length >= bestBase.length) {
        best = o
        bestBase = base
      }
    }
  }
  return best
}

/**
 * Read the live active-editor context for `root`, whichever engine is mounted
 * there. Omit `root` to read whichever editor mounted most recently. Returns
 * null when no editor can read — callers surface that as "no editor is
 * connected" rather than throwing.
 */
export async function readActiveFromProjectEditor(
  root?: string
): Promise<ActiveEditorContext | null> {
  const opener = resolveReadOpener(root)
  if (!opener?.readActive) return null
  return opener.readActive()
}

/**
 * Retain a request for the next matching editor registration without offering
 * it to an already-mounted dormant opener. This is used when navigation also
 * changes tabs and the destination editor has not mounted yet.
 */
export function deferProjectEditorOpen(absolutePath: string, line?: number, column?: number): void {
  pendingOpen = { absolutePath, line, column }
}

/** Test-only: drop every registered opener. */
export function __resetProjectEditorBridgeForTesting(): void {
  openers.clear()
  pendingOpen = null
}
