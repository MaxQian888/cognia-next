/**
 * useGitRepo — panel-side binding. Sets the active repo path into the store and
 * triggers an initial load. It does NOT own the fs watcher: the always-mounted
 * StatusBar controller (`useGitBranchIndicator`) is the single watcher owner,
 * which avoids an unmount race where closing the panel would stop a watcher the
 * StatusBar still needs. Refresh also runs after every mutation (see
 * `useGitActions`), so panel freshness never depends on the watcher event.
 */

"use client"

import { useCallback, useEffect, useState } from "react"
import {
  gitWorkspaceList,
  isSourceControlUiAvailable,
  type RemoteGitWorkspace,
} from "@/lib/git/commands"
import { gitTargetFromRemote, parseGitTarget } from "@/lib/git/target"
import { isTauri } from "@/lib/tauri"
import { loadGitRepo } from "@/lib/git/load"
import { useGitStore } from "@/stores/git/git-store"
import { openFolderAsWorkspace } from "@/lib/workspace/open-folder"

export interface UseGitRepoResult {
  available: boolean
  rootDir: string | null
  refresh: () => Promise<void>
  /** Open a folder as a real workspace and bind the panel to it. */
  openFolder: () => Promise<void>
  remoteWorkspaces: RemoteGitWorkspace[]
  selectRemoteWorkspace: (workspace: RemoteGitWorkspace) => void
  remote: boolean
}

export function useGitRepo(): UseGitRepoResult {
  const available = isSourceControlUiAvailable()
  const rootDir = useGitStore((s) => s.rootDir)
  const setRootDir = useGitStore((s) => s.setRootDir)
  const [remoteWorkspaces, setRemoteWorkspaces] = useState<RemoteGitWorkspace[]>([])
  const remote = !isTauri()

  const refresh = useCallback(() => loadGitRepo(rootDir), [rootDir])

  const openFolder = useCallback(async () => {
    // Unified flow: open the folder as a real workspace Project (visible in the
    // switcher, persisted, drives the cwd chain). The always-mounted git
    // indicator (`use-git-branch-indicator`) then binds `rootDir` to the new
    // active project root — no direct `setRootDir` needed here.
    await openFolderAsWorkspace()
  }, [])

  // Initial load when the bound repo changes (idempotent with the controller).
  useEffect(() => {
    if (!available || !rootDir) return
    void loadGitRepo(rootDir).catch(() => undefined)
  }, [available, rootDir])

  const refreshRemoteWorkspaces = useCallback(async () => {
    if (!available || !remote) return
    const workspaces = await gitWorkspaceList()
    setRemoteWorkspaces(workspaces)
    const currentRoot = useGitStore.getState().rootDir
    const selected = currentRoot ? parseGitTarget(currentRoot) : null
    const selectedStillAuthorized =
      selected?.kind === "remote" &&
      workspaces.some((workspace) => workspace.workspaceId === selected.workspaceId)
    if (!selectedStillAuthorized && workspaces[0]) {
      setRootDir(
        gitTargetFromRemote(workspaces[0].workspaceId, workspaces[0].repositoryState.rootDir ?? "")
      )
    } else if (!selectedStillAuthorized && workspaces.length === 0 && selected?.kind === "remote") {
      setRootDir(null)
    }
  }, [available, remote, setRootDir])

  useEffect(() => {
    if (!available || !remote) return
    const initialId = window.setTimeout(() => {
      void refreshRemoteWorkspaces().catch(() => undefined)
    }, 0)
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void refreshRemoteWorkspaces().catch(() => undefined)
        const currentRoot = useGitStore.getState().rootDir
        if (currentRoot) void loadGitRepo(currentRoot).catch(() => undefined)
      }
    }, 5_000)
    return () => {
      window.clearTimeout(initialId)
      window.clearInterval(id)
    }
  }, [available, refreshRemoteWorkspaces, remote])

  const selectRemoteWorkspace = useCallback(
    (workspace: RemoteGitWorkspace) => {
      setRootDir(
        gitTargetFromRemote(workspace.workspaceId, workspace.repositoryState.rootDir ?? "")
      )
    },
    [setRootDir]
  )

  return {
    available,
    rootDir,
    refresh,
    openFolder,
    remoteWorkspaces,
    selectRemoteWorkspace,
    remote,
  }
}
