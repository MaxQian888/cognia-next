"use client"

// State engine for the project Editor tab. Owns the selected root, the set of
// open files (with draft/saved content for dirty tracking), the active file,
// and the persistence + LSP-root wiring. Kept as a hook (not a store) so each
// mounted team workspace is independent; the durable slice lives in
// `agent-team-store.editorSession[teamId]`.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  listWorkspaceDir,
  readWorkspaceFile,
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
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { loggers } from "@cognia/logging"

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
  /** Set when the file changed on disk under us while open. */
  externallyChanged?: boolean
}

export interface UseProjectEditorArgs {
  teamId: string
  /** The team's base working directory (the main repo root). */
  workingDir: string
  /** Injectable deps for testing. */
  deps?: Partial<ProjectEditorDeps>
}

export interface ProjectEditorDeps {
  listDir: typeof listWorkspaceDir
  readFile: typeof readWorkspaceFile
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

export function useProjectEditor({ teamId, workingDir, deps }: UseProjectEditorArgs) {
  const d = useMemo(() => ({ ...defaultDeps, ...deps }), [deps])

  const persisted = useAgentTeamStore((s) => s.editorSession[teamId])
  const setEditorSession = useAgentTeamStore((s) => s.setEditorSession)

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
    setEditorSession(teamId, {
      rootKey,
      openPaths: openFiles.map((f) => f.relPath),
      activePath,
    })
  }, [teamId, rootKey, openFiles, activePath, setEditorSession])

  // ── File operations ─────────────────────────────────────────────────────
  const openFile = useCallback(
    async (relPath: string) => {
      setActivePath(relPath)
      if (openPathsRef.current.has(relPath)) return
      openPathsRef.current.add(relPath)
      try {
        const content = await d.readFile(rootPath, relPath)
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
      prev.map((f) => (f.relPath === relPath ? { ...f, draftContent: content } : f))
    )
  }, [])

  const saveFile = useCallback(
    async (relPath: string) => {
      const file = openFiles.find((f) => f.relPath === relPath)
      if (!file) return
      await d.writeFile(rootPath, relPath, file.draftContent)
      setOpenFiles((prev) =>
        prev.map((f) =>
          f.relPath === relPath
            ? { ...f, savedContent: f.draftContent, externallyChanged: false }
            : f
        )
      )
    },
    [d, rootPath, openFiles]
  )

  const saveAll = useCallback(async () => {
    const dirty = openFiles.filter((f) => f.draftContent !== f.savedContent)
    for (const f of dirty) {
      await d.writeFile(rootPath, f.relPath, f.draftContent)
    }
    if (dirty.length > 0) {
      setOpenFiles((prev) =>
        prev.map((f) => ({ ...f, savedContent: f.draftContent, externallyChanged: false }))
      )
    }
  }, [d, rootPath, openFiles])

  const reloadFile = useCallback(
    async (relPath: string) => {
      try {
        const content = await d.readFile(rootPath, relPath)
        setOpenFiles((prev) =>
          prev.map((f) =>
            f.relPath === relPath
              ? { ...f, savedContent: content, draftContent: content, externallyChanged: false }
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
  }
}
