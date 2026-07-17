/**
 * useGitRepo — panel-side binding. Sets the active repo path into the store and
 * triggers an initial load. It does NOT own the fs watcher: the always-mounted
 * StatusBar controller (`useGitBranchIndicator`) is the single watcher owner,
 * which avoids an unmount race where closing the panel would stop a watcher the
 * StatusBar still needs. Refresh also runs after every mutation (see
 * `useGitActions`), so panel freshness never depends on the watcher event.
 */

"use client"

import { useCallback, useEffect } from "react"
import { isSourceControlUiAvailable } from "@/lib/git/commands"
import { loadGitRepo } from "@/lib/git/load"
import { useGitStore } from "@/stores/git/git-store"
import { openFolderAsWorkspace } from "@/lib/workspace/open-folder"

export interface UseGitRepoResult {
  available: boolean
  rootDir: string | null
  refresh: () => Promise<void>
  /** Open a folder as a real workspace and bind the panel to it. */
  openFolder: () => Promise<void>
}

export function useGitRepo(): UseGitRepoResult {
  const available = isSourceControlUiAvailable()
  const rootDir = useGitStore((s) => s.rootDir)

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
    void loadGitRepo(rootDir)
  }, [available, rootDir])

  return { available, rootDir, refresh, openFolder }
}
