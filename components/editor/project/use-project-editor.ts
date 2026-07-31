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
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([])
  const [activePath, setActivePath] = useState<string | null>(null)
  // Guards the one-shot session restore so re-renders don't re-open files.
  const restoredRef = useRef(false)
  // Synchronous mirror of the open relPaths so rapid sequential `openFile`
  // calls (before React flushes state) don't re-read a file that is already
  // opening. Kept in lockstep with `openFiles` by the mutators below.
  const openPathsRef = useRef<Set<string>>(new Set())

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
      })
      .catch((err) => editorLogger.debug("worktree list failed", { err: String(err) }))
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
    setEditorSession(scopeKey, {
      rootKey,
      openPaths: openFiles.map((f) => f.relPath),
      activePath,
    })
  }, [scopeKey, rootKey, openFiles, activePath, setEditorSession])

  // ── File operations ─────────────────────────────────────────────────────
  const openFile = useCallback(
    async (relPath: string) => {
      setActivePath(relPath)
      if (openPathsRef.current.has(relPath)) return
      openPathsRef.current.add(relPath)
      try {
        const [content, stat] = await Promise.all([
          d.readFile(rootPath, relPath),
          d.statFile(rootPath, relPath).catch(() => null),
        ])
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
        openPathsRef.current.delete(relPath) // allow a later retry
        editorLogger.warn("open file failed", { relPath, err: String(err) })
      }
    },
    [d, rootPath]
  )

  const closeFile = useCallback(
    (relPath: string) => {
      const idx = openFiles.findIndex((f) => f.relPath === relPath)
      const remaining = openFiles.filter((f) => f.relPath !== relPath)
      openPathsRef.current.delete(relPath)
      setOpenFiles(remaining)
      setActivePath((cur) => {
        if (cur !== relPath) return cur
        const fallback = remaining[Math.min(idx, remaining.length - 1)]
        return fallback?.relPath ?? null
      })
    },
    [openFiles]
  )

  const setDraft = useCallback((relPath: string, content: string) => {
    setOpenFiles((prev) =>
      prev.map((f) =>
        f.relPath === relPath
          ? { ...f, draftContent: content, draftVersion: f.draftVersion + 1 }
          : f
      )
    )
  }, [])

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

  const selectRoot = useCallback((key: string) => {
    setRootKey(key)
    openPathsRef.current.clear()
    setOpenFiles([])
    setActivePath(null)
  }, [])

  // ── One-shot session restore (reopen persisted files for this root) ─────
  useEffect(() => {
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
    // Intentionally one-shot on mount — openFile is stable enough for a restore.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
    [rootPath, scopeKey]
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
    dirtyCount,
    treeRefreshToken,
    selectRoot,
    openFile,
    closeFile,
    setActivePath,
    setDraft,
    saveFile,
    saveAll,
    reloadFile,
    renameOpenFile,
  }
}
