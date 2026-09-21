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
  /** Set when the file changed on disk under us while open. */
  externallyChanged?: boolean
}

/**
 * Above this byte size a file opens as a `too-large` placeholder rather than
 * being pulled into a Monaco model — the read alone would stall the tab, and
 * the editor's own feature set (minimap, folding, tokens) degrades far earlier
 * than this ceiling.
 */
export const MAX_EDITOR_BYTES = 10 * 1024 * 1024

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
}

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

  // ── Persist the session (root / open files / active file) ───────────────
  useEffect(() => {
    if (!rootsReady) return
    setEditorSession(scopeKey, {
      rootKey,
      openPaths: openFiles.map((f) => f.relPath),
      activePath,
    })
  }, [scopeKey, rootKey, openFiles, activePath, rootsReady, setEditorSession])

  // ── File operations ─────────────────────────────────────────────────────

  /** Drop a tab that lost the preview slot. No active-tab fallback: the caller
   *  is in the middle of activating its replacement. */
  const evictTab = useCallback(
    (relPath: string) => {
      openPathsRef.current.delete(relPath)
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
      preserveOnError: boolean
    ) => {
      const stillOurs = () =>
        openPathsRef.current.has(relPath) && openSeqRef.current.get(relPath) === seq
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
        const blocked =
          binaryByName || (!read.ok && isUtf8ReadError(read.error))
            ? ("binary" as const)
            : tooLarge
              ? ("too-large" as const)
              : undefined
        if (!blocked && !read.ok) throw read.error
        const content = blocked ? "" : read.ok ? read.content : ""
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
          const next = [...prev]
          next[idx] = {
            ...entry,
            draftVersion: prev[idx].draftVersion + 1,
            mtime: stat?.mtimeMs ?? prev[idx].mtime,
            sizeBytes: stat?.size ?? prev[idx].sizeBytes,
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
   * Closing a dirty tab destroys the only copy of the user's work — reopening
   * re-reads the file from disk, not the draft. Any close path (⌘W, Close
   * Others/Right/All) confirms once when dirty tabs are in scope; a cancel
   * leaves the whole close a no-op.
   */
  const confirmDirtyClose = useCallback(
    (relPaths: readonly string[]): boolean => {
      const dirty = relPaths.filter((p) => {
        const f = openFilesRef.current.find((o) => o.relPath === p)
        return f !== undefined && f.draftContent !== f.savedContent
      })
      if (dirty.length === 0) return true
      const message =
        dirty.length === 1
          ? t("closeDirtyConfirm", { name: dirty[0].split("/").pop() ?? dirty[0] })
          : t("closeDirtyConfirmCount", { count: dirty.length })
      return typeof window.confirm === "function" ? window.confirm(message) : false
    },
    [t]
  )

  const closeFile = useCallback(
    (relPath: string) => {
      if (!confirmDirtyClose([relPath])) return
      const idx = openFiles.findIndex((f) => f.relPath === relPath)
      const remaining = openFiles.filter((f) => f.relPath !== relPath)
      rememberClosed([relPath])
      openPathsRef.current.delete(relPath)
      releaseFileModel(joinRootRel(rootPath, relPath))
      setTabState(forgetTab(tabStateRef.current, relPath))
      setOpenFiles(remaining)
      const fallback = remaining[Math.min(idx, remaining.length - 1)]?.relPath ?? null
      setActivePath((cur) => (cur !== relPath ? cur : fallback))
      if (activePathRef.current === relPath) activePathRef.current = fallback
    },
    [openFiles, rootPath, releaseFileModel, setTabState, rememberClosed, confirmDirtyClose]
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
  const closeFiles = useCallback(
    (closing: ReadonlySet<string>) => {
      if (closing.size === 0) return
      if (!confirmDirtyClose([...closing])) return
      const remaining = openFiles.filter((f) => !closing.has(f.relPath))
      const activeIdx = openFiles.findIndex((f) => f.relPath === activePathRef.current)
      rememberClosed(openFiles.filter((f) => closing.has(f.relPath)).map((f) => f.relPath))
      for (const f of openFiles) {
        if (!closing.has(f.relPath)) continue
        openPathsRef.current.delete(f.relPath)
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
    [openFiles, rootPath, releaseFileModel, setTabState, rememberClosed, confirmDirtyClose]
  )

  const closeOtherFiles = useCallback(
    (relPath: string) => {
      closeFiles(new Set(openFiles.map((f) => f.relPath).filter((p) => p !== relPath)))
    },
    [closeFiles, openFiles]
  )

  const closeFilesToRight = useCallback(
    (relPath: string) => {
      const idx = openFiles.findIndex((f) => f.relPath === relPath)
      if (idx === -1) return
      closeFiles(new Set(openFiles.slice(idx + 1).map((f) => f.relPath)))
    },
    [closeFiles, openFiles]
  )

  const closeAllFiles = useCallback(() => {
    closeFiles(new Set(openFiles.map((f) => f.relPath)))
  }, [closeFiles, openFiles])

  /**
   * Reopen the most recently closed tab (⌘⇧T / Ctrl+Shift+T). A no-op when the
   * history is empty; a path that no longer exists surfaces through the normal
   * failed-open path inside `openFile`.
   */
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

  const saveFile = useCallback(
    async (relPath: string) => {
      const file = openFiles.find((f) => f.relPath === relPath)
      // A `binary`/`too-large` placeholder tab holds an empty buffer, not the
      // file's content — writing it would erase the real file on disk.
      if (!file || file.blocked) return
      await d.writeFile(rootPath, relPath, file.draftContent)
      const stat = await d.statFile(rootPath, relPath).catch(() => null)
      setOpenFiles((prev) =>
        prev.map((f) =>
          f.relPath === relPath
            ? {
                ...f,
                savedContent: f.draftContent,
                externallyChanged: false,
                mtime: stat?.mtimeMs ?? f.mtime,
              }
            : f
        )
      )
    },
    [d, rootPath, openFiles]
  )

  const saveAll = useCallback(async () => {
    const dirty = openFiles.filter((f) => f.draftContent !== f.savedContent && !f.blocked)
    const mtimes = new Map<string, number>()
    for (const f of dirty) {
      await d.writeFile(rootPath, f.relPath, f.draftContent)
      const stat = await d.statFile(rootPath, f.relPath).catch(() => null)
      if (stat?.mtimeMs != null) mtimes.set(f.relPath, stat.mtimeMs)
    }
    if (dirty.length > 0) {
      setOpenFiles((prev) =>
        prev.map((f) => ({
          ...f,
          savedContent: f.draftContent,
          externallyChanged: false,
          mtime: mtimes.get(f.relPath) ?? f.mtime,
        }))
      )
    }
  }, [d, rootPath, openFiles])

  const reloadFile = useCallback(
    async (relPath: string) => {
      // Route through the open-time classifier: a binary or oversized file
      // must never be pulled into a draft, and a forced-open file re-checks
      // the ceiling on every reload. `preserveOnError`: the tab is live — a
      // failed reload keeps it (and any unsaved draft) and the caller sees
      // the error.
      const seq = (openSeqRef.current.get(relPath) ?? 0) + 1
      openSeqRef.current.set(relPath, seq)
      await readIntoTab(relPath, seq, false, null, true)
    },
    [readIntoTab]
  )

  const selectRoot = useCallback(
    (key: string) => {
      setRootKey(key)
      openPathsRef.current.clear()
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
  useEffect(() => {
    if (!rootsReady) return
    if (restoredRef.current) return
    if (!persisted || persisted.rootKey !== rootKey) {
      restoredRef.current = true
      return
    }
    restoredRef.current = true
    const toOpen = persisted.openPaths ?? []
    void (async () => {
      for (const relPath of toOpen) {
        await openFile(relPath)
      }
      if (persisted.activePath) setActivePath(persisted.activePath)
    })()
    // Intentionally one-shot after worktree discovery validates the persisted root.
  }, [openFile, persisted, rootKey, rootsReady])

  // ── External-change watch: mark open files, notify tree consumers ───────
  const [treeRefreshToken, setTreeRefreshToken] = useState(0)
  useEffect(() => {
    if (!rootPath) return
    const dispose = d.watch(rootPath, (change) => {
      setTreeRefreshToken((n) => n + 1)
      // Flag any open file that changed on disk so the UI can offer a reload.
      setOpenFiles((prev) =>
        prev.map((f) => (f.absolutePath === change.path ? { ...f, externallyChanged: true } : f))
      )
    })
    return dispose
  }, [d, rootPath])

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
    closeOtherFiles,
    closeFilesToRight,
    closeAllFiles,
    reopenClosedFile,
    setActivePath,
    setDraft,
    saveFile,
    saveAll,
    reloadFile,
    renameOpenFile,
  }
}
