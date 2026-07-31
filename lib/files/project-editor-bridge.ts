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
  /**
   * Flush this editor's unsaved buffers to disk, returning the absolute paths it
   * could not save.
   *
   * Optional because not every engine has buffers that can diverge from disk, but
   * where it exists it is a correctness requirement rather than a nicety: the
   * agent's file tools read the filesystem, so an unsaved buffer is invisible to
   * them and a turn can reason about stale content and then overwrite the user's
   * work. See {@link flushProjectEditorEdits}.
   */
  saveDirty?: () => Promise<string[]>
  /**
   * Show `content` against the on-disk file (path relative to `root`) as a diff, so
   * a proposed change can be reviewed before it is written. Optional: an engine
   * without a diff surface omits it and callers fall back to writing directly.
   */
  showDiff?: (relPath: string, content: string, title?: string) => Promise<void>
  /** Reveal a file (path relative to `root`) in this editor's file tree. */
  reveal?: (relPath: string) => Promise<void>
  /** Run a command in this editor's own terminal, visible to the user. */
  runInTerminal?: (command: string, options?: { cwd?: string; name?: string }) => Promise<void>
  /** Surface an app-side message inside this editor. */
  notify?: (message: string, kind?: "info" | "warning" | "error") => Promise<void>
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
function resolveOpenerForRoot(
  root: string | undefined,
  canAnswer: (opener: ProjectEditorOpener) => boolean
): ProjectEditorOpener | null {
  // No root asked for: the caller (a plugin, say) has no reason to know project
  // roots and just wants whatever the user is in. Latest capable registration
  // wins, which is the most recently mounted editor.
  if (root === undefined) {
    let latest: ProjectEditorOpener | null = null
    for (const o of openers) if (canAnswer(o)) latest = o
    return latest
  }

  let best: ProjectEditorOpener | null = null
  let bestBase = ""
  const normalizedRoot = normalizePath(root)
  for (const o of openers) {
    if (!canAnswer(o)) continue
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

function resolveReadOpener(root?: string): ProjectEditorOpener | null {
  return resolveOpenerForRoot(root, (o) => o.readActive != null)
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
 * Flush unsaved editor buffers to disk before something reads the filesystem.
 *
 * Call this ahead of any agent turn that may read or write project files. The
 * agent's file tools go straight to disk, so an editor buffer the user has edited
 * but not saved is invisible to them — the agent reads the stale copy, reasons about
 * code that is already out of date, and its write then clobbers the user's unsaved
 * work. Flushing first is what makes disk an honest source of truth.
 *
 * Flushes *every* registered editor rather than the one nearest a path: a turn is
 * not scoped to a single file, and an editor whose root doesn't obviously contain
 * the file can still be holding a dirty buffer the agent will touch.
 *
 * Returns the absolute paths that could not be saved. An empty array means disk is
 * trustworthy; a non-empty one is what the caller should warn about. Never throws —
 * an engine that fails to save is reported, not allowed to abort the turn.
 */
export async function flushProjectEditorEdits(): Promise<string[]> {
  const flushable = [...openers].filter((o) => o.saveDirty)
  const results = await Promise.all(
    flushable.map(async (o) => {
      try {
        return await o.saveDirty!()
      } catch {
        // The engine could not tell us which files failed, only that it failed.
        // Reporting its root is more useful than reporting nothing.
        return [o.root]
      }
    })
  )
  return [...new Set(results.flat())]
}

/**
 * Preview `content` against an absolute path as a diff in whichever editor is
 * rooted there. Returns false when no editor can show a diff, so the caller can
 * fall back to writing directly.
 */
export async function showDiffInProjectEditor(
  absolutePath: string,
  content: string,
  title?: string
): Promise<boolean> {
  const resolved = resolveOpener(absolutePath)
  if (!resolved?.opener.showDiff) return false
  await resolved.opener.showDiff(resolved.rel, content, title)
  return true
}

/** Reveal an absolute path in whichever editor's file tree is rooted there. */
export async function revealInProjectEditor(absolutePath: string): Promise<boolean> {
  const resolved = resolveOpener(absolutePath)
  if (!resolved?.opener.reveal) return false
  await resolved.opener.reveal(resolved.rel)
  return true
}

/**
 * Run a command in the terminal of the editor rooted at `root`.
 *
 * Keyed by root (not by a file path) because a command belongs to a project, not to
 * a file. Returns false when no editor there owns a terminal.
 */
export async function runInProjectEditorTerminal(
  root: string,
  command: string,
  options?: { cwd?: string; name?: string }
): Promise<boolean> {
  const opener = resolveOpenerForRoot(root, (o) => o.runInTerminal != null)
  if (!opener?.runInTerminal) return false
  await opener.runInTerminal(command, options)
  return true
}

/**
 * Surface a message inside the editor rooted at `root` — or, with no root, the most
 * recently mounted editor that can show one. Returns false when none can.
 */
export async function notifyInProjectEditor(
  message: string,
  kind?: "info" | "warning" | "error",
  root?: string
): Promise<boolean> {
  const opener = resolveOpenerForRoot(root, (o) => o.notify != null)
  if (!opener?.notify) return false
  await opener.notify(message, kind)
  return true
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
