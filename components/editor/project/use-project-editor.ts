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
import { languageFromPath, type EditorLanguage } from "@/components/editor/editor-language"
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
  savedContent: string
  draftContent: string
  /** Monotonic in-memory model version used by proposal compare-and-swap. */
  draftVersion: number
  /** Last observed filesystem mtime used by proposal compare-and-swap. */
  mtime?: number
  /** Set when the file changed on disk under us while open. */
  externallyChanged?: boolean
}

export interface UseProjectEditorArgs {
  /** Stable persistence key, e.g. `team:<id>` or `session:<id>`. */
  scopeKey: string
  /** The team's base working directory (the main repo root). */
  workingDir: string
  /** Injectable deps for testing. */
  deps?: Partial<ProjectEditorDeps>
}

export interface ProjectEditorDeps {
  listDir: typeof listWorkspaceDir
  readFile: typeof readWorkspaceFile
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

export function useProjectEditor({ scopeKey, workingDir, deps }: UseProjectEditorArgs) {
  const d = useMemo(() => ({ ...defaultDeps, ...deps }), [deps])

  const persisted = useProjectEditorSessionStore((s) => s.sessions[scopeKey])
  const setEditorSession = useProjectEditorSessionStore((s) => s.setSession)

  const [roots, setRoots] = useState<ProjectRoot[]>([
    { key: workingDir, label: "main", path: workingDir, isMain: true },
  ])
  const [rootKey, setRootKey] = useState<string>(persisted?.rootKey || workingDir)
  const [rootsReady, setRootsReady] = useState(false)
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([])
  const [activePath, setActivePath] = useState<string | null>(null)
  // Guards the one-shot session restore so re-renders don't re-open files.
  const restoredRef = useRef(false)
  // Synchronous mirror of the open relPaths so rapid sequential `openFile`
  // calls (before React flushes state) don't re-read a file that is already
  // opening. Kept in lockstep with `openFiles` by the mutators below.
  const openPathsRef = useRef<Set<string>>(new Set())
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
        setRoots(next)
        setRootKey((current) => (next.some((root) => root.key === current) ? current : workingDir))
        setRootsReady(true)
      })
      .catch((err) => {
        if (cancelled) return
        editorLogger.debug("worktree list failed", { err: String(err) })
        setRootKey(workingDir)
        setRootsReady(true)
      })
    return () => {
      cancelled = true
    }
  }, [d, workingDir])

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

  const openFile = useCallback(
    async (relPath: string, options?: { mode?: EditorTabMode }) => {
      // Pinned by default: every existing caller (session restore, search jump,
      // the agent bridge, "new file") means "keep this open".
      const mode = options?.mode ?? "pinned"
      const isOpen = openPathsRef.current.has(relPath)
      const transition = resolveTabIntent(tabStateRef.current, { relPath, mode, isOpen })
      setTabState(transition.state)
      setActivePath(relPath)
      if (transition.evicted) evictTab(transition.evicted)
      if (isOpen) return
      openPathsRef.current.add(relPath)
      const seq = (openSeqRef.current.get(relPath) ?? 0) + 1
      openSeqRef.current.set(relPath, seq)
      /** Whether this attempt still owns the tab it opened. */
      const stillOurs = () =>
        openPathsRef.current.has(relPath) && openSeqRef.current.get(relPath) === seq
      retainFileModel(joinRootRel(rootPath, relPath))
      try {
        const [content, stat] = await Promise.all([
          d.readFile(rootPath, relPath),
          d.statFile(rootPath, relPath).catch(() => null),
        ])
        // Opening a second preview while this read was in flight evicts this
        // tab — `evictTab` has already dropped the ref entry and released the
        // model. Appending anyway would resurrect the evicted file and leave
        // two tabs in the single reusable preview slot.
        if (!stillOurs()) return
        setOpenFiles((prev) => {
          if (prev.some((f) => f.relPath === relPath)) return prev
          return [
            ...prev,
            {
              relPath,
              absolutePath: joinRootRel(rootPath, relPath),
              language: languageFromPath(relPath),
              savedContent: content,
              draftContent: content,
              draftVersion: 1,
              mtime: stat?.mtimeMs ?? undefined,
            },
          ]
        })
      } catch (err) {
        // A failed read only gets to tear the tab down if the tab is still the
        // one it opened. Otherwise the path has been evicted (already released)
        // or re-opened by a newer read, and closing it here would blank a tab
        // the user is looking at.
        if (stillOurs()) {
          openPathsRef.current.delete(relPath) // allow a later retry
          releaseFileModel(joinRootRel(rootPath, relPath))
        }
        editorLogger.warn("open file failed", { relPath, err: String(err) })
      }
    },
    [d, rootPath, retainFileModel, releaseFileModel, evictTab, setTabState]
  )

  /** Promote a preview tab to permanent (double-click, explicit pin). */
  const pinFile = useCallback(
    (relPath: string) => setTabState(pinTab(tabStateRef.current, relPath)),
    [setTabState]
  )

  const closeFile = useCallback(
    (relPath: string) => {
      const idx = openFiles.findIndex((f) => f.relPath === relPath)
      const remaining = openFiles.filter((f) => f.relPath !== relPath)
      openPathsRef.current.delete(relPath)
      releaseFileModel(joinRootRel(rootPath, relPath))
      setTabState(forgetTab(tabStateRef.current, relPath))
      setOpenFiles(remaining)
      setActivePath((cur) => {
        if (cur !== relPath) return cur
        const fallback = remaining[Math.min(idx, remaining.length - 1)]
        return fallback?.relPath ?? null
      })
    },
    [openFiles, rootPath, releaseFileModel, setTabState]
  )

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
      if (!file) return
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
    const dirty = openFiles.filter((f) => f.draftContent !== f.savedContent)
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
      try {
        const [content, stat] = await Promise.all([
          d.readFile(rootPath, relPath),
          d.statFile(rootPath, relPath).catch(() => null),
        ])
        setOpenFiles((prev) =>
          prev.map((f) =>
            f.relPath === relPath
              ? {
                  ...f,
                  savedContent: content,
                  draftContent: content,
                  draftVersion: f.draftVersion + 1,
                  externallyChanged: false,
                  mtime: stat?.mtimeMs ?? f.mtime,
                }
              : f
          )
        )
      } catch (err) {
        editorLogger.debug("reload failed", { relPath, err: String(err) })
      }
    },
    [d, rootPath]
  )

  const selectRoot = useCallback(
    (key: string) => {
      setRootKey(key)
      openPathsRef.current.clear()
      // The new root's files live at different absolute paths, so every model
      // held for the old root is now unreachable.
      releaseAllFileModels()
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
    setActivePath,
    setDraft,
    saveFile,
    saveAll,
    reloadFile,
    renameOpenFile,
  }
}
