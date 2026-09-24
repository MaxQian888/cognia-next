"use client"

// State engine for the project Editor tab. Owns the selected root, the set of
// open files (with draft/saved content for dirty tracking), the active file,
// and the persistence + LSP-root wiring. Kept as a hook (not a store) so each
// mounted editor scope is independent; the durable slice lives in the generic
// project-editor session store under `scopeKey`.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  listWorkspaceDir,
  readWorkspaceFile,
  readWorkspaceFileBase64,
  statWorkspaceFile,
  writeWorkspaceFile,
  createWorkspaceDir,
  deleteWorkspaceEntry,
  renameWorkspaceEntry,
} from "@/lib/files/workspace-fs"
import { gitWorktreeList } from "@/lib/git/commands"
import {
  registerProjectWorkspace,
  unregisterProjectWorkspace,
} from "@/lib/plugin/vscode-shim/lsp-workspace-manager"
import { watchWorkspace } from "@/lib/files/workspace-watch"
import { pathToFileUri } from "@/lib/files/path-uri"
import {
  releaseModel,
  releaseModels,
  retainModel,
} from "@/lib/editor-workbench/monaco-model-registry"
import {
  EMPTY_EDITOR_TAB_STATE,
  forgetTab,
  pinTab,
  renameTab,
  resolveTabIntent,
  type EditorTabMode,
  type EditorTabState,
} from "@/lib/editor-workbench/editor-tab-model"
import {
  languageFromPath,
  monacoLanguageFromPath,
  type EditorLanguage,
} from "@/components/editor/editor-language"
import { reconcileSelectedRoot } from "@/lib/workspace/panel-follow"
import { useTranslations } from "next-intl"
import { useProjectEditorSessionStore } from "@/stores/editor/project-editor-session-store"
import { loggers } from "@cognia/logging"
import { getDb } from "@/lib/db/schema"
import { migrateResourceSessionBinding } from "@/lib/context-workbench/resource-session"
import { isTauri } from "@/lib/platform/detect"
import { onTransportChange } from "@/lib/tauri/transport-instance"
import { isRemoteHostActive, subscribeActiveRemoteTransport } from "@/lib/tauri/transport-routing"

const editorLogger = loggers.agent.child("project-editor")

/** A selectable project root — the main repo or one of its worktrees. */
export interface ProjectRoot {
  /** Stable key = absolute path. */
  key: string
  /** Display label (branch name, or "main"). */
  label: string
  /** Absolute working directory. */
  path: string
  isMain: boolean
}

export interface OpenFile {
  /** Path relative to the active root. */
  relPath: string
  absolutePath: string
  language: EditorLanguage
  /** Full-fidelity Monaco id (`rust`, `go`, `html`, …); `language` stays on the closed CM union. */
  monacoLanguage: string
  savedContent: string
  draftContent: string
  /** Monotonic in-memory model version used by proposal compare-and-swap. */
  draftVersion: number
  /** Last observed filesystem mtime used by proposal compare-and-swap. */
  mtime?: number
  /** Byte size as reported by stat at open; feeds the status bar + fallback pane. */
  sizeBytes?: number
  /**
   * Set when the tab deliberately did NOT load text into an editor: `binary`
   * for non-UTF-8 content (images, archives, executables — detected by
   * extension or a failed UTF-8 read), `too-large` for files over
   * {@link MAX_EDITOR_BYTES} the user can still force open. The workbench
   * renders a fallback pane instead of an editor for these.
   */
  blocked?: "binary" | "too-large"
  /**
   * Set when the file changed on disk under us while open AND the tab still
   * holds an unsaved draft — i.e. the two sides are in conflict. A clean tab
   * never carries this flag: its buffer simply reloads to match the disk.
   */
  externallyChanged?: boolean
  /**
   * Set when the file was deleted on disk while its tab stayed open. The
   * buffer survives — saving restores it — but the tab has to say the file
   * is gone. Cleared by the next external create/modify or by a reload.
   */
  deletedOnDisk?: boolean
}

/**
 * Above this byte size a file opens as a `too-large` placeholder rather than
 * being pulled into a Monaco model — the read alone would stall the tab, and
 * the editor's own feature set (minimap, folding, tokens) degrades far earlier
 * than this ceiling.
 */
export const MAX_EDITOR_BYTES = 10 * 1024 * 1024

/**
 * The fs watcher cannot tell our own `writeFile` from an agent's. A save
 * stamps its path here and watch events inside the grace window are the
 * echo of that write, not an external change. Two seconds covers notify
 * latency across platforms without meaningfully masking a real write that
 * lands right behind ours (the remote stat-poll still catches those).
 */
const SELF_WRITE_GRACE_MS = 2_000

/**
 * Extensions whose content can never be UTF-8 source text. Skipping the read
 * outright is both faster (no doomed round trip) and more accurate than
 * waiting for the decoder to fail: an `.png` that happens to decode is still
 * not something a text editor can show meaningfully.
 */
const BINARY_EXTENSIONS = new Set([
  // images
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "ico",
  "icns",
  "bmp",
  "tif",
  "tiff",
  "psd",
  "ai",
  "heic",
  "heif",
  // media
  "mp3",
  "wav",
  "flac",
  "ogg",
  "m4a",
  "aac",
  "mp4",
  "mov",
  "mkv",
  "avi",
  "webm",
  "m4v",
  "wmv",
  // fonts
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  // archives / bundles
  "zip",
  "tar",
  "gz",
  "tgz",
  "bz2",
  "xz",
  "7z",
  "rar",
  "jar",
  "war",
  "dmg",
  "iso",
  // executables / object code
  "exe",
  "dll",
  "so",
  "dylib",
  "bin",
  "dat",
  "o",
  "a",
  "class",
  "wasm",
  "pyc",
  "pyo",
  // documents + data stores
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "sqlite",
  "sqlite3",
  "db",
  "parquet",
  "arrow",
  // misc binary (`.cer`/`.crt` stay out — those are usually PEM text)
  "sketch",
  "fig",
  "p12",
  "pfx",
  "der",
])

function isProbablyBinaryPath(relPath: string): boolean {
  const name = relPath.split("/").pop() ?? ""
  const dot = name.lastIndexOf(".")
  // `> 0`: a leading dot is part of the name (`.gitignore`), not an extension.
  if (dot <= 0) return false
  return BINARY_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())
}

/** The Rust text read reports undecodable content through its io error text. */
function isUtf8ReadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /utf-?8/i.test(message)
}

export interface UseProjectEditorArgs {
  /** Stable persistence key, e.g. `team:<id>` or `session:<id>`. */
  scopeKey: string
  /** The team's base working directory (the main repo root). */
  workingDir: string
  /**
   * Where this editor would follow to — the bound conversation's execution
   * root. The persisted `rootKey` IS the pin: equal to this means following,
   * anything else means the user deliberately pinned. Omitted (Agent Team's
   * editor, tests) leaves the pre-follow behaviour untouched.
   */
  followedRoot?: string | null
  /** Injectable deps for testing. */
  deps?: Partial<ProjectEditorDeps>
  /**
   * Host-provided confirmation for destructive gates (dirty close, overwrite
   * external change, revert). May be sync or async — an AlertDialog host
   * returns a promise. Falls back to `window.confirm`; when neither exists
   * the destructive path is refused rather than waved through.
   * Boolean answers are part of the contract — a host bridging
   * `window.confirm` naturally resolves true/false; `askConfirm`
   * normalizes them to confirm/cancel.
   */
  confirm?: (
    request: ProjectEditorConfirmRequest
  ) => ProjectEditorConfirmVerdict | boolean | Promise<ProjectEditorConfirmVerdict | boolean>
}

/** A destructive-gate prompt: message body plus the affirmative button label. */
export interface ProjectEditorConfirmRequest {
  message: string
  confirmLabel: string
  /**
   * Present on the dirty-close gate only: a third "save the draft first"
   * choice, like VS Code's Save / Don't Save / Cancel. A host that ignores it
   * degrades to the binary confirm/cancel pair.
   */
  saveLabel?: string
}

/**
 * What the user answered. `"confirm"` = the destructive action (don't save /
 * overwrite / discard), `"save"` = keep the draft by writing it first,
 * `"cancel"` = abort. Boolean answers normalize to confirm/cancel so a plain
 * `window.confirm` fallback keeps working.
 */
export type ProjectEditorConfirmVerdict = "confirm" | "save" | "cancel"

export interface ProjectEditorDeps {
  listDir: typeof listWorkspaceDir
  readFile: typeof readWorkspaceFile
  readFileBase64: typeof readWorkspaceFileBase64
  statFile: typeof statWorkspaceFile
  writeFile: typeof writeWorkspaceFile
  createDir: typeof createWorkspaceDir
  deleteEntry: typeof deleteWorkspaceEntry
  renameEntry: typeof renameWorkspaceEntry
  listWorktrees: typeof gitWorktreeList
  registerLspRoot: typeof registerProjectWorkspace
  unregisterLspRoot: typeof unregisterProjectWorkspace
  watch: typeof watchWorkspace
}

const defaultDeps: ProjectEditorDeps = {
  listDir: listWorkspaceDir,
  readFile: readWorkspaceFile,
  readFileBase64: readWorkspaceFileBase64,
  statFile: statWorkspaceFile,
  writeFile: writeWorkspaceFile,
  createDir: createWorkspaceDir,
  deleteEntry: deleteWorkspaceEntry,
  renameEntry: renameWorkspaceEntry,
  listWorktrees: gitWorktreeList,
  registerLspRoot: registerProjectWorkspace,
  unregisterLspRoot: unregisterProjectWorkspace,
  watch: watchWorkspace,
}

/** Join a root and a forward-slashed relPath into an absolute path. */
export function joinRootRel(root: string, relPath: string): string {
  const base = root.replace(/[\\/]+$/, "")
  return relPath ? `${base}/${relPath}` : base
}

/**
 * Make sure the conversation's execution root is selectable.
 *
 * `git worktree list` covers worktrees of the repo it is run in; a managed
 * workspace can live outside that (a shadow checkout for a non-Git root, a
 * bundle alias). Without this, an editor asked to follow such a root would
 * find the selection unavailable and fall back to the repo — silently showing
 * a different tree than the agent is editing.
 */
function withFollowedRoot(roots: ProjectRoot[], followedRoot?: string | null): ProjectRoot[] {
  const followed = followedRoot?.trim()
  if (!followed || roots.some((root) => root.key === followed)) return roots
  return [
    ...roots,
    {
      key: followed,
      label: followed.split(/[\\/]/).filter(Boolean).pop() ?? followed,
      path: followed,
      isMain: false,
    },
  ]
}

/** The initial reconciliation, batched with worktree discovery. */
function reconcileSelected(
  current: string,
  roots: ProjectRoot[],
  followedRoot?: string | null
): string {
  return (
    reconcileSelectedRoot({
      selected: current,
      followed: followedRoot,
      available: roots.map((root) => root.key),
    }).selected ?? current
  )
}

export function useProjectEditor({
  scopeKey,
  workingDir,
  followedRoot,
  deps,
  confirm: confirmArg,
}: UseProjectEditorArgs) {
  const d = useMemo(() => ({ ...defaultDeps, ...deps }), [deps])
  const t = useTranslations("projectEditor")

  const persisted = useProjectEditorSessionStore((s) => s.sessions[scopeKey])
  const setEditorSession = useProjectEditorSessionStore((s) => s.setSession)

  const [roots, setRoots] = useState<ProjectRoot[]>([
    { key: workingDir, label: "main", path: workingDir, isMain: true },
  ])
  const [rootKey, setRootKey] = useState<string>(
    persisted?.rootKey || followedRoot?.trim() || workingDir
  )
  const [rootsReady, setRootsReady] = useState(false)
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([])
  const [activePath, setActivePath] = useState<string | null>(null)
  // Committed mirror of `activePath` — `openFile` needs the *previous* path
  // synchronously so a failed read can put the selection back where it was.
  const activePathRef = useRef<string | null>(null)
  useEffect(() => {
    activePathRef.current = activePath
  }, [activePath])
  // Guards the one-shot session restore so re-renders don't re-open files.
  const restoredRef = useRef(false)
  // Synchronous mirror of the open relPaths so rapid sequential `openFile`
  // calls (before React flushes state) don't re-read a file that is already
  // opening. Kept in lockstep with `openFiles` by the mutators below.
  const openPathsRef = useRef<Set<string>>(new Set())
  // Same reason as `openPathsRef` for the file entries themselves: `openFile`
  // must know whether the existing tab is `blocked` (to honour an explicit
  // "open anyway") without adding `openFiles` — which changes on every
  // keystroke — to its dependency list.
  const openFilesRef = useRef<OpenFile[]>([])
  useEffect(() => {
    openFilesRef.current = openFiles
  }, [openFiles])
  // Per-path open counter. `openFile` reads a file asynchronously, so by the
  // time a read settles the tab may have been evicted, closed, *or* re-opened —
  // and the last case is invisible to `openPathsRef` alone, since the path is
  // back in the set under a newer read. Stamping each attempt lets a stale one
  // recognise that it no longer owns the tab and leave both the file list and
  // the model retain count to whoever does.
  const openSeqRef = useRef<Map<string, number>>(new Map())
  // `file://` URIs this hook currently holds in the Monaco model registry, kept
  // in lockstep with `openPathsRef`. Open documents — not editor mounts — are
  // what keeps a model (and its undo stack) alive, so the retain/release pairs
  // live here rather than in the Monaco component.
  const openUrisRef = useRef<Set<string>>(new Set())

  const retainFileModel = useCallback((absolutePath: string) => {
    const uri = pathToFileUri(absolutePath)
    if (openUrisRef.current.has(uri)) return
    openUrisRef.current.add(uri)
    retainModel(uri)
  }, [])

  const releaseFileModel = useCallback((absolutePath: string) => {
    const uri = pathToFileUri(absolutePath)
    if (!openUrisRef.current.delete(uri)) return
    releaseModel(uri)
  }, [])

  const releaseAllFileModels = useCallback(() => {
    const uris = [...openUrisRef.current]
    openUrisRef.current.clear()
    releaseModels(uris)
  }, [])

  // Preview/pinned tab state. Mirrored into a ref for the same reason
  // `openPathsRef` exists: `openFile` must resolve the transition synchronously,
  // and a state updater is not allowed to have the side effects a transition
  // implies (evicting a tab, releasing its model).
  const [tabState, setTabStateValue] = useState<EditorTabState>(EMPTY_EDITOR_TAB_STATE)
  const tabStateRef = useRef(tabState)
  // LIFO of relPaths the user closed, most recent last — the "reopen closed
  // tab" stack. Ref rather than state: nothing renders from it.
  const closedHistoryRef = useRef<string[]>([])
  const rememberClosed = useCallback((paths: string[]) => {
    const history = closedHistoryRef.current
    for (const path of paths) {
      const existing = history.indexOf(path)
      if (existing !== -1) history.splice(existing, 1)
      history.push(path)
    }
    if (history.length > 20) history.splice(0, history.length - 20)
  }, [])
  const setTabState = useCallback((next: EditorTabState) => {
    if (next === tabStateRef.current) return
    tabStateRef.current = next
    setTabStateValue(next)
  }, [])

  // Tearing the editor down closes every document it had open. Without this the
  // `keepCurrentModel` that protects the undo stack would leak a model per file
  // for the lifetime of the tab.
  useEffect(() => releaseAllFileModels, [releaseAllFileModels])

  const activeRoot = useMemo(
    () => roots.find((r) => r.key === rootKey) ?? roots[0],
    [roots, rootKey]
  )
  const rootPath = activeRoot?.path ?? workingDir
  const operationEpoch = useRef(0)
  const documentEpochs = useRef(new Map<string, number>())
  const [hostRevision, setHostRevision] = useState(0)
  useEffect(
    () => () => {
      operationEpoch.current += 1
      documentEpochs.current.clear()
    },
    [rootPath, d]
  )
  const pendingSaves = useRef(new Map<string, Promise<boolean>>())
  // Absolute paths this hook wrote itself, by write-completion time. Read by
  // the fs-watch callback to tell our own save's echo from a real external
  // (usually agent) write.
  const recentSelfWrites = useRef(new Map<string, number>())
  useEffect(() => {
    const invalidate = () => {
      operationEpoch.current += 1
      setHostRevision((revision) => revision + 1)
      setOpenFiles((files) => files.map((file) => ({ ...file, externallyChanged: true })))
    }
    const stopTransport = onTransportChange(invalidate)
    const stopRemote = subscribeActiveRemoteTransport(invalidate)
    return () => {
      stopTransport()
      stopRemote()
    }
  }, [])

  // ── Worktree discovery ──────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    void d
      .listWorktrees(workingDir)
      .then((wts) => {
        if (cancelled) return
        const next: ProjectRoot[] = [
          { key: workingDir, label: "main", path: workingDir, isMain: true },
        ]
        for (const wt of wts) {
          if (wt.path === workingDir || wt.isMain) continue
          next.push({
            key: wt.path,
            label: wt.branch ?? wt.path.split("/").pop() ?? wt.path,
            path: wt.path,
            isMain: false,
          })
        }
        const merged = withFollowedRoot(next, followedRoot)
        setRoots(merged)
        // Reconciled in the SAME batch as `rootsReady`, not in the effect
        // below: the session-restore effect gates on `persisted.rootKey ===
        // rootKey`, and a reconciliation deferred by one commit would let it
        // restore a stale root's open files before the correction landed.
        setRootKey((current) => reconcileSelected(current, merged, followedRoot))
        setRootsReady(true)
      })
      .catch((err) => {
        if (cancelled) return
        editorLogger.debug("worktree list failed", { err: String(err) })
        // Discovery failing must not strand the editor on the repo root while
        // the conversation runs somewhere else — the follow target is known
        // independently of `git worktree list`.
        const merged = withFollowedRoot(
          [{ key: workingDir, label: "main", path: workingDir, isMain: true }],
          followedRoot
        )
        setRoots(merged)
        setRootKey((current) => reconcileSelected(current, merged, followedRoot))
        setRootsReady(true)
      })
    return () => {
      cancelled = true
    }
  }, [d, workingDir, followedRoot])

  // ── Follow / pin reconciliation ─────────────────────────────────────────
  // The persisted `rootKey` IS the pin (see `reconcileSelectedRoot`). Pruning a
  // stale selection happens with worktree discovery above; this effect handles
  // only the other half — a follow target that MOVES, because the user switched
  // to a conversation running elsewhere or a managed worktree finished
  // materializing. An editor that was following moves with it; a pinned one
  // does not.
  const previousFollowedRef = useRef<string | null>(followedRoot?.trim() || null)
  useEffect(() => {
    const followed = followedRoot?.trim() || null
    const previous = previousFollowedRef.current
    // Guarded on an actual change, not just on re-running: without this the
    // effect fires on the discovery commit too, one render before the batched
    // reconciliation above is visible, and re-decides from a stale `rootKey`.
    if (previous === followed) return
    previousFollowedRef.current = followed
    if (!rootsReady) return
    setRootKey(
      (current) =>
        reconcileSelectedRoot({
          selected: current,
          followed,
          previousFollowed: previous,
          available: roots.map((root) => root.key),
        }).selected ?? current
    )
  }, [followedRoot, roots, rootsReady])

  const pinned = useMemo(
    () =>
      reconcileSelectedRoot({
        selected: rootKey,
        followed: followedRoot,
        available: roots.map((root) => root.key),
      }).pinned,
    [rootKey, followedRoot, roots]
  )

  const resumeFollow = useCallback(() => {
    const followed = followedRoot?.trim()
    if (followed) setRootKey(followed)
  }, [followedRoot])

  // ── LSP workspace root: register the active root, re-register on switch ──
  useEffect(() => {
    if (!rootPath) return
    d.registerLspRoot(rootPath)
    return () => d.unregisterLspRoot(rootPath)
  }, [d, rootPath])

  // Flips once the session-restore loop below has run — every persisted path
  // is then marked in `openPathsRef` even though its read may still be in
  // flight. Both the persist effect and the workbench's split restore gate on
  // it: during the restore window the record must keep the snapshot being
  // restored from, not a half-populated live state.
  const [sessionRestored, setSessionRestored] = useState(false)

  // ── Persist the session (root / open files / active file) ───────────────
  // `openFiles` gets a new identity on every keystroke (draftContent lives in
  // it) — serializing all sessions to localStorage per keypress is wasted
  // work, so the write is gated on the persisted fields actually changing.
  const lastPersistedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!rootsReady || !sessionRestored) return
    // The open set is `openPathsRef` (paths are marked the moment `openFile`
    // is called), not `openFiles` (a tab materializes when its read lands).
    // Serializing `openFiles` alone would write a transient empty/partial
    // list over the record during every in-flight open — most visibly right
    // after session restore, when the whole set is marked but nothing has
    // landed yet. Landed tabs keep their visual order; in-flight marks
    // append in open order, matching where their tabs will land.
    const landed = openFiles.map((f) => f.relPath)
    const openPaths = [...landed]
    for (const relPath of openPathsRef.current) {
      if (!openPaths.includes(relPath)) openPaths.push(relPath)
    }
    const key = JSON.stringify([rootKey, openPaths, activePath])
    if (key === lastPersistedRef.current) return
    lastPersistedRef.current = key
    setEditorSession(scopeKey, { rootKey, openPaths, activePath })
  }, [scopeKey, rootKey, openFiles, activePath, rootsReady, sessionRestored, setEditorSession])

  // ── File operations ─────────────────────────────────────────────────────

  /** Drop a tab that lost the preview slot. No active-tab fallback: the caller
   *  is in the middle of activating its replacement. */
  const evictTab = useCallback(
    (relPath: string) => {
      openPathsRef.current.delete(relPath)
      documentEpochs.current.delete(relPath)
      releaseFileModel(joinRootRel(rootPath, relPath))
      setOpenFiles((prev) => prev.filter((f) => f.relPath !== relPath))
    },
    [rootPath, releaseFileModel]
  )

  /**
   * Read + classify a file into its open tab. Runs for fresh opens and for
   * the "open anyway" re-load on a `too-large` placeholder; `seq` identifies
   * which attempt owns the tab so a stale read can't resurrect an evicted or
   * re-opened file. `preserveOnError` marks a re-load of a tab that already
   * exists (revert, forced open): its failure must keep the tab's state
   * intact and propagate to the caller instead of tearing the tab down.
   */
  const readIntoTab = useCallback(
    async (
      relPath: string,
      seq: number,
      allowLarge: boolean,
      previousActivePath: string | null,
      preserveOnError: boolean,
      preserveIfDirty = false
    ) => {
      const epoch = operationEpoch.current
      const stillOurs = () =>
        operationEpoch.current === epoch &&
        openPathsRef.current.has(relPath) &&
        openSeqRef.current.get(relPath) === seq
      const binaryByName = isProbablyBinaryPath(relPath)
      try {
        // Stat first: a file over the ceiling opens as a `too-large`
        // placeholder without any read — the old parallel read still pulled
        // ~MAX_EDITOR_BYTES through IPC just to throw the content away. A
        // failed stat stays non-fatal: the capped read below is the backstop.
        const stat = await d.statFile(rootPath, relPath).catch(() => null)
        const tooLarge = !allowLarge && stat !== null && stat.size > MAX_EDITOR_BYTES
        // Evicted/re-opened while the stat was in flight — skip the read
        // entirely; whoever owns the tab now is running their own.
        if (!stillOurs()) return
        const read =
          binaryByName || tooLarge
            ? { ok: false as const, error: null }
            : await d
                // Forced opens pass no cap: the Rust reader would otherwise
                // append a truncation marker into what looks like the file.
                .readFile(rootPath, relPath, allowLarge ? undefined : MAX_EDITOR_BYTES + 1)
                .then((content) => ({ ok: true as const, content }))
                .catch((error: unknown) => ({ ok: false as const, error }))
        // Opening a second preview while this read was in flight evicts this
        // tab — `evictTab` has already dropped the ref entry and released the
        // model. Appending anyway would resurrect the evicted file and leave
        // two tabs in the single reusable preview slot.
        if (!stillOurs()) return
        // Stat can fail or the file can grow between stat and read. The host's
        // capped preview appends a truncation marker; that is never editable
        // file content. Check UTF-8 bytes, not UTF-16 string length.
        const oversizedRead =
          !allowLarge && read.ok && new Blob([read.content]).size > MAX_EDITOR_BYTES
        const blocked =
          binaryByName || (!read.ok && isUtf8ReadError(read.error))
            ? ("binary" as const)
            : tooLarge || oversizedRead
              ? ("too-large" as const)
              : undefined
        if (!blocked && !read.ok) throw read.error
        const content = blocked ? "" : read.ok ? read.content : ""
        // A failed reload must not authorize an old host's retained draft.
        documentEpochs.current.set(relPath, epoch)
        setOpenFiles((prev) => {
          const entry: OpenFile = {
            relPath,
            absolutePath: joinRootRel(rootPath, relPath),
            language: languageFromPath(relPath),
            monacoLanguage: monacoLanguageFromPath(relPath),
            savedContent: content,
            draftContent: content,
            draftVersion: 1,
            mtime: stat?.mtimeMs ?? undefined,
            sizeBytes: stat?.size,
            blocked,
            externallyChanged: false,
          }
          const idx = prev.findIndex((f) => f.relPath === relPath)
          if (idx === -1) return [...prev, entry]
          // A re-load keeps the tab's version lineage so Monaco keeps the
          // model swap monotonic instead of re-creating it from scratch. A
          // rejected stat keeps the metadata the earlier read recorded rather
          // than regressing it to "unknown".
          const current = prev[idx]
          // `preserveIfDirty` is the auto-reload path: the user typed while
          // the read was in flight, so the buffer is now unsaved work and the
          // disk content arriving is the *other* side of a conflict — keep
          // the draft, advance the baseline, and flag it.
          const dirtiedInFlight = preserveIfDirty && current.draftContent !== current.savedContent
          const next = [...prev]
          next[idx] = {
            ...entry,
            draftVersion: current.draftVersion + 1,
            mtime: stat?.mtimeMs ?? current.mtime,
            sizeBytes: stat?.size ?? current.sizeBytes,
            ...(dirtiedInFlight
              ? { draftContent: current.draftContent, externallyChanged: true }
              : {}),
          }
          return next
        })
      } catch (err) {
        // A reload/re-read of a tab that already exists keeps the tab intact —
        // its draft, model and selection all stay — and the error propagates
        // so the caller can surface it. Only a fresh open's failure tears down.
        if (preserveOnError) {
          editorLogger.warn("file reload failed", { relPath, err: String(err) })
          throw err
        }
        // A failed read only gets to tear the tab down if the tab is still the
        // one it opened. Otherwise the path has been evicted (already released)
        // or re-opened by a newer read, and closing it here would blank a tab
        // the user is looking at.
        if (stillOurs()) {
          openPathsRef.current.delete(relPath) // allow a later retry
          releaseFileModel(joinRootRel(rootPath, relPath))
          // The click already moved the selection — leaving it on a file that
          // never opened parked `activePath` on a phantom tab forever.
          setTabState(forgetTab(tabStateRef.current, relPath))
          const restored =
            previousActivePath !== null && openPathsRef.current.has(previousActivePath)
              ? previousActivePath
              : null
          setActivePath((current) => (current === relPath ? restored : current))
          if (activePathRef.current === relPath) activePathRef.current = restored
        }
        editorLogger.warn("open file failed", { relPath, err: String(err) })
      }
    },
    [d, rootPath, releaseFileModel, setTabState]
  )

  const openFile = useCallback(
    async (relPath: string, options?: { mode?: EditorTabMode; allowLarge?: boolean }) => {
      // Pinned by default: every existing caller (session restore, search jump,
      // the agent bridge, "new file") means "keep this open".
      const mode = options?.mode ?? "pinned"
      const isOpen = openPathsRef.current.has(relPath)
      // Captured before the selection moves: a failed read reverts to it.
      const previousActivePath = activePathRef.current
      const transition = resolveTabIntent(tabStateRef.current, { relPath, mode, isOpen })
      setTabState(transition.state)
      setActivePath(relPath)
      // Sync the mirror now — a second openFile in the same commit must see
      // this path as "previous", not the one the last effect committed.
      activePathRef.current = relPath
      if (transition.evicted) evictTab(transition.evicted)
      if (isOpen) {
        // "Open anyway" on a `too-large` placeholder re-runs the load with the
        // size ceiling lifted; anything else on an already-open path is a no-op
        // beyond the focus above.
        const existing = openFilesRef.current.find((f) => f.relPath === relPath)
        if (options?.allowLarge && existing?.blocked === "too-large") {
          const seq = (openSeqRef.current.get(relPath) ?? 0) + 1
          openSeqRef.current.set(relPath, seq)
          // The placeholder tab already exists — a failed forced read keeps it
          // (already logged inside); nothing further to surface here.
          void readIntoTab(relPath, seq, true, previousActivePath, true).catch(() => {})
        }
        return
      }
      openPathsRef.current.add(relPath)
      const seq = (openSeqRef.current.get(relPath) ?? 0) + 1
      openSeqRef.current.set(relPath, seq)
      retainFileModel(joinRootRel(rootPath, relPath))
      void readIntoTab(relPath, seq, options?.allowLarge === true, previousActivePath, false)
    },
    [retainFileModel, evictTab, setTabState, readIntoTab, rootPath]
  )

  /** Promote a preview tab to permanent (double-click, explicit pin). */
  const pinFile = useCallback(
    (relPath: string) => setTabState(pinTab(tabStateRef.current, relPath)),
    [setTabState]
  )

  /**
   * Ask the host (or `window.confirm`) a yes/no question. Sync when no host
   * dialog is wired so callers on the plain path never wait a microtask.
   */
  const askConfirm = useCallback(
    (
      request: ProjectEditorConfirmRequest
    ): ProjectEditorConfirmVerdict | Promise<ProjectEditorConfirmVerdict> => {
      const normalize = (v: ProjectEditorConfirmVerdict | boolean): ProjectEditorConfirmVerdict =>
        v === true ? "confirm" : v === false ? "cancel" : v
      if (confirmArg !== undefined) {
        const verdict = confirmArg(request)
        return typeof verdict === "string" || typeof verdict === "boolean"
          ? normalize(verdict)
          : verdict.then(normalize)
      }
      return typeof window.confirm === "function"
        ? normalize(window.confirm(request.message))
        : "cancel"
    },
    [confirmArg]
  )

  /**
   * Closing a dirty tab destroys the only copy of the user's work — reopening
   * re-reads the file from disk, not the draft. Any close path (⌘W, Close
   * Others/Right/All) confirms once when dirty tabs are in scope; a cancel
   * leaves the whole close a no-op.
   */
  const confirmDirtyClose = useCallback(
    (
      relPaths: readonly string[]
    ): ProjectEditorConfirmVerdict | Promise<ProjectEditorConfirmVerdict> => {
      const dirty = relPaths.filter((p) => {
        const f = openFilesRef.current.find((o) => o.relPath === p)
        return f !== undefined && f.draftContent !== f.savedContent
      })
      if (dirty.length === 0) return "confirm"
      const message =
        dirty.length === 1
          ? t("closeDirtyConfirm", { name: dirty[0].split("/").pop() ?? dirty[0] })
          : t("closeDirtyConfirmCount", { count: dirty.length })
      // VS Code's three-way: Don't Save / Cancel / Save. `saveLabel` tells the
      // host dialog to offer the save-first path.
      return askConfirm({
        message,
        confirmLabel: t("confirmDontSave"),
        saveLabel: t("confirmSave"),
      })
    },
    [t, askConfirm]
  )

  /**
   * Overwriting a disk version the buffer never saw silently discards the
   * external (usually agent) write — confirm once instead. Mirrors
   * `confirmDirtyClose`: when `window.confirm` is unavailable the destructive
   * path is refused rather than waved through.
   */
  const confirmOverwriteExternal = useCallback(
    (
      files: readonly OpenFile[]
    ): ProjectEditorConfirmVerdict | Promise<ProjectEditorConfirmVerdict> => {
      const conflicted = files.filter((f) => f.externallyChanged)
      if (conflicted.length === 0) return "confirm"
      const message =
        conflicted.length === 1
          ? t("overwriteExternalConfirm", {
              name: conflicted[0].relPath.split("/").pop() ?? conflicted[0].relPath,
            })
          : t("overwriteExternalConfirmCount", { count: conflicted.length })
      return askConfirm({ message, confirmLabel: t("confirmOverwrite") })
    },
    [t, askConfirm]
  )

  /**
   * Reverting a dirty tab destroys the draft — the reload itself is
   * unconditional, so this gate is the only thing between a stray menu click
   * and lost work. Clean tabs revert freely (reload is harmless there).
   */
  const confirmDiscardDraft = useCallback(
    (relPath: string): ProjectEditorConfirmVerdict | Promise<ProjectEditorConfirmVerdict> => {
      const file = openFilesRef.current.find((f) => f.relPath === relPath)
      if (!file || file.draftContent === file.savedContent) return "confirm"
      return askConfirm({
        message: t("revertDirtyConfirm", { name: relPath.split("/").pop() ?? relPath }),
        confirmLabel: t("confirmDiscard"),
      })
    },
    [t, askConfirm]
  )

  /**
   * Run `onConfirm`/`onSave` for the verdict. A string verdict executes
   * synchronously (the plain `window.confirm` path never waits a microtask);
   * a promise — a host dialog — defers the mutation until the user answers.
   */
  const whenConfirmed = useCallback(
    (
      verdict: ProjectEditorConfirmVerdict | Promise<ProjectEditorConfirmVerdict>,
      onConfirm: () => void,
      onSave?: () => void
    ) => {
      const run = (v: ProjectEditorConfirmVerdict) => {
        if (v === "confirm") onConfirm()
        else if (v === "save") onSave?.()
      }
      if (typeof verdict === "string") run(verdict)
      else void verdict.then(run)
    },
    []
  )

  /** Reorder tabs by drag-and-drop: move `fromRelPath` onto `toRelPath`'s slot. */
  const moveOpenFile = useCallback((fromRelPath: string, toRelPath: string) => {
    setOpenFiles((prev) => {
      const from = prev.findIndex((f) => f.relPath === fromRelPath)
      const to = prev.findIndex((f) => f.relPath === toRelPath)
      if (from === -1 || to === -1 || from === to) return prev
      const next = [...prev]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return next
    })
  }, [])

  /**
   * Close every tab whose relPath is in `closing`. Active-tab fallback mirrors
   * `closeFile`: the neighbour that slid into the closed tab's slot, or the
   * new last tab.
   */
  const performCloseMany = useCallback(
    (closing: ReadonlySet<string>) => {
      const current = openFilesRef.current
      const remaining = current.filter((f) => !closing.has(f.relPath))
      const activeIdx = current.findIndex((f) => f.relPath === activePathRef.current)
      rememberClosed(current.filter((f) => closing.has(f.relPath)).map((f) => f.relPath))
      for (const f of current) {
        if (!closing.has(f.relPath)) continue
        openPathsRef.current.delete(f.relPath)
        documentEpochs.current.delete(f.relPath)
        releaseFileModel(joinRootRel(rootPath, f.relPath))
      }
      let nextTabState = tabStateRef.current
      for (const relPath of closing) nextTabState = forgetTab(nextTabState, relPath)
      setTabState(nextTabState)
      setOpenFiles(remaining)
      const fallback =
        remaining[Math.min(Math.max(activeIdx, 0), remaining.length - 1)]?.relPath ?? null
      setActivePath((cur) => (cur !== null && closing.has(cur) ? fallback : cur))
      if (activePathRef.current !== null && closing.has(activePathRef.current)) {
        activePathRef.current = fallback
      }
    },
    [rootPath, releaseFileModel, setTabState, rememberClosed]
  )

  /**
   * Reopen the most recently closed tab (⌘⇧T / Ctrl+Shift+T). A no-op when the
   * history is empty; a path that no longer exists surfaces through the normal
   * failed-open path inside `openFile`.
   */
  const isOpenPath = useCallback((relPath: string) => openPathsRef.current.has(relPath), [])

  const reopenClosedFile = useCallback(() => {
    const relPath = closedHistoryRef.current.pop()
    if (relPath === undefined) return
    void openFile(relPath)
  }, [openFile])

  const setDraft = useCallback(
    (relPath: string, content: string) => {
      // Editing a preview tab makes it permanent — otherwise the next tree
      // click would evict a buffer the user has unsaved work in.
      setTabState(pinTab(tabStateRef.current, relPath))
      setOpenFiles((prev) =>
        prev.map((f) =>
          f.relPath === relPath
            ? { ...f, draftContent: content, draftVersion: f.draftVersion + 1 }
            : f
        )
      )
    },
    [setTabState]
  )

  const saveSnapshot = useCallback(
    (
      file: OpenFile,
      epoch = operationEpoch.current,
      seq = openSeqRef.current.get(file.relPath),
      confirm?: () => ProjectEditorConfirmVerdict | Promise<ProjectEditorConfirmVerdict>
    ): Promise<boolean> => {
      const current = () =>
        operationEpoch.current === epoch &&
        documentEpochs.current.get(file.relPath) === epoch &&
        file.absolutePath === joinRootRel(rootPath, file.relPath) &&
        openPathsRef.current.has(file.relPath) &&
        openSeqRef.current.get(file.relPath) === seq
      const write = async (): Promise<boolean> => {
        // Queued writes belong to this document incarnation, never a reopened
        // tab or another root. A failed predecessor must not poison retries.
        if (!current()) throw new Error(t("saveContextChanged"))
        // The overwrite confirmation runs at write time — after the context
        // guard, so a draft from a dead host rejects instead of prompting,
        // and the check reads the freshest flag state.
        if (confirm !== undefined && (await confirm()) !== "confirm") return false
        await d.writeFile(rootPath, file.relPath, file.draftContent)
        // Stamp before the watcher can possibly deliver the write's echo.
        recentSelfWrites.current.set(file.absolutePath, Date.now())
        if (!current()) return true
        const stat = await d.statFile(rootPath, file.relPath).catch(() => null)
        if (!current()) return true
        setOpenFiles((prev) =>
          prev.map((f) =>
            f.absolutePath === file.absolutePath
              ? {
                  ...f,
                  savedContent: file.draftContent,
                  externallyChanged: false,
                  // The file provably exists again — saving a `deletedOnDisk`
                  // buffer IS how it gets restored.
                  deletedOnDisk: false,
                  mtime: stat?.mtimeMs ?? f.mtime,
                  sizeBytes: stat?.size ?? f.sizeBytes,
                }
              : f
          )
        )
        return true
      }
      const previous = pendingSaves.current.get(file.absolutePath)
      const saving = previous ? previous.catch(() => {}).then(write) : write()
      pendingSaves.current.set(file.absolutePath, saving)
      const release = () => {
        if (pendingSaves.current.get(file.absolutePath) === saving)
          pendingSaves.current.delete(file.absolutePath)
      }
      void saving.then(release, release)
      return saving
    },
    [d, rootPath, t]
  )

  const saveFile = useCallback(
    async (relPath: string, opts?: { force?: boolean }): Promise<boolean> => {
      const file = openFilesRef.current.find((f) => f.relPath === relPath)
      // Placeholders contain no file bytes and must never be saved.
      if (!file || file.blocked) return false
      const confirm = opts?.force
        ? undefined
        : () => {
            const fresh = openFilesRef.current.find((f) => f.relPath === relPath)
            return fresh !== undefined ? confirmOverwriteExternal([fresh]) : "cancel"
          }
      return saveSnapshot(
        file,
        operationEpoch.current,
        openSeqRef.current.get(file.relPath),
        confirm
      )
    },
    [saveSnapshot, confirmOverwriteExternal]
  )

  const saveAll = useCallback(
    async (opts?: { force?: boolean }) => {
      const dirty = openFilesRef.current.filter(
        (f) => f.draftContent !== f.savedContent && !f.blocked
      )
      const epoch = operationEpoch.current
      const snapshots = dirty.map((file) => ({
        file,
        seq: openSeqRef.current.get(file.relPath),
      }))
      // One batch prompt at the first conflicted write — declined paths are
      // skipped while clean drafts still write. The confirm sits inside
      // saveSnapshot so stale-context drafts reject before any prompt.
      const approved = new Set<string>()
      let asked = false
      const confirm =
        opts?.force === true
          ? undefined
          : async (relPath: string): Promise<ProjectEditorConfirmVerdict> => {
              const fresh = openFilesRef.current.find((f) => f.relPath === relPath)
              if (fresh === undefined) return "cancel"
              if (!fresh.externallyChanged) return "confirm"
              if (!asked) {
                asked = true
                if ((await confirmOverwriteExternal(dirty)) === "confirm")
                  for (const f of dirty) approved.add(f.relPath)
              }
              return approved.has(relPath) ? "confirm" : "cancel"
            }
      for (const { file, seq } of snapshots)
        await saveSnapshot(
          file,
          epoch,
          seq,
          confirm === undefined ? undefined : () => confirm(file.relPath)
        )
    },
    [saveSnapshot, confirmOverwriteExternal]
  )

  /**
   * Save every dirty file in `closing`, then close the ones whose write
   * actually landed. A failed, declined, or skipped save keeps its tab open —
   * answering "Save" must never become a silent discard. The save's own
   * boolean is the signal: `openFiles` cannot be re-read here because its ref
   * only syncs on the next render.
   */
  const saveThenClose = useCallback(
    async (closing: ReadonlySet<string>) => {
      const saved = new Set<string>()
      for (const relPath of closing) {
        const file = openFilesRef.current.find((f) => f.relPath === relPath)
        if (!file || file.blocked) continue
        if (file.draftContent === file.savedContent) {
          saved.add(relPath)
          continue
        }
        try {
          // `force` skips the overwrite re-prompt — the user already answered
          // "Save" once; asking again inside the same gesture double-prompts.
          if (await saveFile(relPath, { force: true })) saved.add(relPath)
        } catch {
          /* keep the tab on failure */
        }
      }
      if (saved.size > 0) performCloseMany(saved)
    },
    [saveFile, performCloseMany]
  )

  const closeFile = useCallback(
    (relPath: string) => {
      whenConfirmed(
        confirmDirtyClose([relPath]),
        () => performCloseMany(new Set([relPath])),
        () => void saveThenClose(new Set([relPath]))
      )
    },
    [confirmDirtyClose, whenConfirmed, performCloseMany, saveThenClose]
  )

  const closeFiles = useCallback(
    (closing: ReadonlySet<string>) => {
      if (closing.size === 0) return
      whenConfirmed(
        confirmDirtyClose([...closing]),
        () => performCloseMany(closing),
        () => void saveThenClose(closing)
      )
    },
    [confirmDirtyClose, whenConfirmed, performCloseMany, saveThenClose]
  )

  const closeAllFiles = useCallback(() => {
    closeFiles(new Set(openFiles.map((f) => f.relPath)))
  }, [closeFiles, openFiles])

  const reloadFile = useCallback(
    async (relPath: string, opts?: { preserveIfDirty?: boolean }) => {
      // Route through the open-time classifier: a binary or oversized file
      // must never be pulled into a draft, and a forced-open file re-checks
      // the ceiling on every reload. `preserveOnError`: the tab is live — a
      // failed reload keeps it (and any unsaved draft) and the caller sees
      // the error.
      const seq = (openSeqRef.current.get(relPath) ?? 0) + 1
      openSeqRef.current.set(relPath, seq)
      await readIntoTab(relPath, seq, false, null, true, opts?.preserveIfDirty === true)
    },
    [readIntoTab]
  )

  /**
   * The tree (or a future host) deleted `deletedRelPaths` — files or
   * directory prefixes. Clean tabs under them just close (reopening a
   * deleted file is impossible anyway); dirty tabs stay open marked
   * `deletedOnDisk`, because their draft may be the last surviving copy.
   * Deletes made outside the tree arrive through the fs watcher instead and
   * converge on the same state.
   */
  const reconcileDeleted = useCallback(
    (deletedRelPaths: string[]) => {
      const prefixes = deletedRelPaths.map((p) => p.replace(/\/+$/, ""))
      const under = (relPath: string) =>
        prefixes.some((p) => relPath === p || relPath.startsWith(`${p}/`))
      const matches = openFilesRef.current.filter((f) => under(f.relPath))
      if (matches.length === 0) return
      const dirty = matches.filter((f) => f.draftContent !== f.savedContent)
      const clean = matches.filter((f) => f.draftContent === f.savedContent)
      const dirtySet = new Set(dirty.map((f) => f.relPath))
      const cleanSet = new Set(clean.map((f) => f.relPath))
      const activeIdx = openFilesRef.current.findIndex((f) => f.relPath === activePathRef.current)
      for (const f of clean) {
        openPathsRef.current.delete(f.relPath)
        documentEpochs.current.delete(f.relPath)
        releaseFileModel(f.absolutePath)
      }
      let nextTabState = tabStateRef.current
      for (const f of clean) nextTabState = forgetTab(nextTabState, f.relPath)
      setTabState(nextTabState)
      // Deleted files are not reopenable — they must not enter the
      // closed-tab history `reopenClosedFile` drains. Flag the dirty survivors
      // and drop the clean ones in a single update so neither pass clobbers
      // the other.
      const remaining = openFilesRef.current
        .map((f) =>
          dirtySet.has(f.relPath) ? { ...f, deletedOnDisk: true, externallyChanged: false } : f
        )
        .filter((f) => !cleanSet.has(f.relPath))
      setOpenFiles(remaining)
      const fallback =
        remaining[Math.min(Math.max(activeIdx, 0), remaining.length - 1)]?.relPath ?? null
      setActivePath((cur) => (cur !== null && cleanSet.has(cur) ? fallback : cur))
      if (activePathRef.current !== null && cleanSet.has(activePathRef.current)) {
        activePathRef.current = fallback
      }
    },
    [releaseFileModel, setTabState]
  )

  const selectRoot = useCallback(
    (key: string) => {
      setRootKey(key)
      openPathsRef.current.clear()
      documentEpochs.current.clear()
      // The new root's files live at different absolute paths, so every model
      // held for the old root is now unreachable. The closed-tab history is
      // likewise meaningless — relPaths only resolve inside their own root.
      releaseAllFileModels()
      closedHistoryRef.current = []
      setTabState(EMPTY_EDITOR_TAB_STATE)
      setOpenFiles([])
      setActivePath(null)
    },
    [releaseAllFileModels, setTabState]
  )

  // ── One-shot session restore (reopen persisted files for this root) ─────
  // `sessionRestored` flips only after every `openFile` call has run — each
  // marks `openPathsRef` synchronously even though its read resolves later.
  // Consumers that restore layout on top of the open set (the workbench's
  // split groups) gate on this, not `rootsReady`: at `rootsReady` time only
  // the first `openFile` in the loop has marked the ref.
  useEffect(() => {
    if (!rootsReady) return
    if (restoredRef.current) return
    if (!persisted || persisted.rootKey !== rootKey) {
      restoredRef.current = true
      /* eslint-disable react-hooks/set-state-in-effect -- one-shot readiness
         flag for consumers gating on the completed restore. */
      setSessionRestored(true)
      /* eslint-enable react-hooks/set-state-in-effect */
      return
    }
    restoredRef.current = true
    const toOpen = persisted.openPaths ?? []
    void (async () => {
      try {
        for (const relPath of toOpen) {
          await openFile(relPath)
        }
        if (persisted.activePath) setActivePath(persisted.activePath)
      } finally {
        // The flag must flip even if an open threw mid-loop — consumers and
        // the persist effect above deadlock on a flag that never arrives.
        setSessionRestored(true)
      }
    })()
    // Intentionally one-shot after worktree discovery validates the persisted root.
  }, [openFile, persisted, rootKey, rootsReady])

  // ── External-change watch: mark open files, notify tree consumers ───────
  const [treeRefreshToken, setTreeRefreshToken] = useState(0)
  // The watcher emits one event per changed path, un-debounced — a bulk
  // write (`npm install`, a build) would otherwise force a tree reload per
  // event. Coalesce into one trailing bump per window.
  const treeBumpTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const bumpTreeRefresh = useCallback(() => {
    if (treeBumpTimer.current !== null) return
    treeBumpTimer.current = setTimeout(() => {
      treeBumpTimer.current = null
      setTreeRefreshToken((n) => n + 1)
    }, 250)
  }, [])
  useEffect(() => {
    if (!rootPath) return
    const dispose = d.watch(rootPath, (change) => {
      bumpTreeRefresh()
      const file = openFilesRef.current.find((f) => f.absolutePath === change.path)
      if (change.kind === "delete") {
        // A recursive watcher may emit only the removed directory's path, so
        // match children by prefix too. Keep the buffer — a dirty draft may
        // be the last surviving copy — but the tab must say the file is gone.
        const under = (abs: string) => abs === change.path || abs.startsWith(`${change.path}/`)
        if (!file && !openFilesRef.current.some((f) => under(f.absolutePath))) return
        setOpenFiles((prev) =>
          prev.map((f) =>
            under(f.absolutePath) && !f.deletedOnDisk
              ? { ...f, deletedOnDisk: true, externallyChanged: false }
              : f
          )
        )
        return
      }
      if (!file) return
      // The echo of our own save — the write still in flight, or one that
      // landed inside the grace window — is not an external change.
      if (pendingSaves.current.has(change.path)) return
      const stamp = recentSelfWrites.current.get(change.path)
      if (stamp !== undefined && Date.now() - stamp < SELF_WRITE_GRACE_MS) return
      if (file.draftContent !== file.savedContent) {
        // A draft is unsaved work; surface the conflict rather than silently
        // swapping whichever side the user didn't mean to drop.
        setOpenFiles((prev) =>
          prev.map((f) =>
            f.absolutePath === change.path && !f.externallyChanged
              ? { ...f, externallyChanged: true, deletedOnDisk: false }
              : f
          )
        )
      } else {
        // A clean buffer mirrors the disk write directly — this is the
        // dock's main purpose: watching what the agent just changed.
        // `preserveIfDirty` covers the user typing while the read flies.
        void reloadFile(file.relPath, { preserveIfDirty: true }).catch(() => {
          // A failed auto-reload still owes the user the signal that the
          // buffer went stale.
          setOpenFiles((prev) =>
            prev.map((f) => (f.relPath === file.relPath ? { ...f, externallyChanged: true } : f))
          )
        })
      }
    })
    return () => {
      if (treeBumpTimer.current !== null) {
        clearTimeout(treeBumpTimer.current)
        treeBumpTimer.current = null
      }
      dispose()
    }
  }, [d, rootPath, hostRevision, reloadFile, bumpTreeRefresh])

  // Remote hosts cannot use plugin_fs_watch (it is explicitly client-local).
  // Probe only metadata for open documents, with one request in flight and no
  // hidden/offline work. Never replace a draft with bytes fetched behind it.
  useEffect(() => {
    let disposed = false
    let running = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const available = () => document.visibilityState !== "hidden" && navigator.onLine !== false
    const poll = async () => {
      if (disposed || running) return
      if (timer !== undefined) clearTimeout(timer)
      running = true
      const epoch = operationEpoch.current
      try {
        if (!available()) return
        if (isTauri() && !isRemoteHostActive()) return
        for (const file of openFilesRef.current) {
          if (disposed || epoch !== operationEpoch.current) break
          if (!available()) break
          if (file.externallyChanged || documentEpochs.current.get(file.relPath) !== epoch) continue
          if (pendingSaves.current.has(file.absolutePath)) continue
          const seq = openSeqRef.current.get(file.relPath)
          const stat = await d.statFile(rootPath, file.relPath).catch(() => null)
          if (
            !stat ||
            disposed ||
            epoch !== operationEpoch.current ||
            pendingSaves.current.has(file.absolutePath)
          )
            continue
          if (seq !== openSeqRef.current.get(file.relPath)) continue
          if (!stat.exists) {
            if (!file.deletedOnDisk) {
              setOpenFiles((files) =>
                files.map((current) =>
                  current === file
                    ? { ...current, deletedOnDisk: true, externallyChanged: false }
                    : current
                )
              )
            }
            continue
          }
          if (stat.size === file.sizeBytes && stat.mtimeMs === file.mtime) continue
          if (file.draftContent !== file.savedContent) {
            setOpenFiles((files) =>
              files.map((current) =>
                current === file
                  ? { ...current, externallyChanged: true, deletedOnDisk: false }
                  : current
              )
            )
          } else {
            // Same rule as the local watcher: a clean buffer mirrors the
            // disk write instead of just flagging it.
            void reloadFile(file.relPath, { preserveIfDirty: true }).catch(() => {})
          }
        }
      } finally {
        running = false
        if (!disposed)
          timer = setTimeout(() => {
            void poll()
          }, 5000)
      }
    }
    const resume = () => {
      void poll()
    }
    timer = setTimeout(resume, 5000)
    document.addEventListener("visibilitychange", resume)
    window.addEventListener("online", resume)
    return () => {
      disposed = true
      clearTimeout(timer)
      document.removeEventListener("visibilitychange", resume)
      window.removeEventListener("online", resume)
    }
  }, [d, rootPath, reloadFile])

  const renameOpenFile = useCallback(
    async (from: string, to: string) => {
      const migratePath = (path: string) =>
        path === from ? to : path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : path
      try {
        const sessions = await getDb().sessions.toArray()
        await Promise.all(
          sessions.flatMap((session) => {
            const binding = session.surfaceBinding
            if (
              session.kind !== "resource-workbench" ||
              binding?.kind !== "project-file" ||
              binding.projectId !== scopeKey ||
              binding.rootId !== rootPath
            ) {
              return []
            }
            const relPath = migratePath(binding.relPath)
            if (relPath === binding.relPath) return []
            return [
              migrateResourceSessionBinding(
                session.id,
                { ...binding, relPath },
                { update: (id, patch) => getDb().sessions.update(id, patch) }
              ),
            ]
          })
        )
      } catch (error) {
        editorLogger.warn("resource session rename migration failed", { error })
      }
      // A rename changes the `file://` URI, so the model behind the old URI is
      // orphaned and a fresh one is created at the new one. Move the registry
      // hold before touching state — a state updater must stay pure.
      for (const previousRelPath of [...openPathsRef.current]) {
        const relPath = migratePath(previousRelPath)
        if (relPath === previousRelPath) continue
        openPathsRef.current.delete(previousRelPath)
        openPathsRef.current.add(relPath)
        const epoch = documentEpochs.current.get(previousRelPath)
        documentEpochs.current.delete(previousRelPath)
        if (epoch !== undefined) documentEpochs.current.set(relPath, epoch)
        releaseFileModel(joinRootRel(rootPath, previousRelPath))
        retainFileModel(joinRootRel(rootPath, relPath))
      }
      closedHistoryRef.current = closedHistoryRef.current.map(migratePath)
      setTabState(renameTab(tabStateRef.current, from, to))
      setOpenFiles((previous) =>
        previous.map((file) => {
          const relPath = migratePath(file.relPath)
          return relPath === file.relPath
            ? file
            : {
                ...file,
                relPath,
                absolutePath: joinRootRel(rootPath, relPath),
                language: languageFromPath(relPath),
                monacoLanguage: monacoLanguageFromPath(relPath),
                // A rename can move a file across the binary-extension line
                // (`foo.png` → `foo.txt`), so the placeholder flag is only as
                // good as the new name — the next reload re-classifies fully.
                blocked:
                  file.blocked === "binary" && !isProbablyBinaryPath(relPath)
                    ? undefined
                    : file.blocked,
              }
        })
      )
      setActivePath((previous) => (previous ? migratePath(previous) : previous))
    },
    [rootPath, scopeKey, releaseFileModel, retainFileModel, setTabState]
  )

  const dirtyCount = useMemo(
    () => openFiles.filter((f) => f.draftContent !== f.savedContent).length,
    [openFiles]
  )
  const activeFile = useMemo(
    () => openFiles.find((f) => f.relPath === activePath) ?? null,
    [openFiles, activePath]
  )

  return {
    deps: d,
    scopeKey,
    roots,
    rootKey,
    rootPath,
    /** True once worktree discovery finished — session restores gate on it. */
    rootsReady,
    /** True once the persisted open set has been (re)marked — the moment
        `isPathOpen` answers for every restored path, before its reads land. */
    sessionRestored,
    /** Where this editor would follow to, or null when nothing is bound. */
    followedRoot: followedRoot?.trim() || null,
    /** True when the selection deliberately diverges from the follow target. */
    pinned,
    /** Return to following the bound conversation. */
    resumeFollow,
    openFiles,
    activePath,
    activeFile,
    /** relPath of the single preview (italic) tab, or `null`. */
    previewPath: tabState.previewPath,
    dirtyCount,
    treeRefreshToken,
    selectRoot,
    openFile,
    pinFile,
    closeFile,
    moveOpenFile,
    /**
     * Close an explicit set of tabs behind one dirty-confirm. Group-scoped
     * close-others / close-to-the-right are built on it by the workbench,
     * which alone knows each editor group's tab order.
     */
    closeFiles,
    closeAllFiles,
    reopenClosedFile,
    setActivePath,
    /**
     * Live "is this path open" — reads `openPathsRef`, so it is true for a
     * file whose read is still in flight (openFiles lags a commit behind).
     * The workbench's group reconcile needs exactly that window covered.
     */
    isPathOpen: isOpenPath,
    setDraft,
    saveFile,
    saveAll,
    reloadFile,
    renameOpenFile,
    /**
     * The file(s) under these relPaths were deleted on disk. Clean tabs
     * close; dirty tabs stay open flagged `deletedOnDisk`.
     */
    reconcileDeleted,
    /** Confirm-before-destroy for a dirty tab's revert. */
    confirmDiscardDraft,
  }
}
