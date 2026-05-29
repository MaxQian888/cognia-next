/**
 * useGitBranchIndicator — the always-mounted Source Control controller, driven
 * by the StatusBar. It is the single owner of the fs watcher + status-changed
 * subscription, so the branch/sync indicator stays live and the panel can rely
 * on it without managing its own watcher. Seeds the store's repo binding from
 * the active project's `rootDir` on first run.
 */

"use client"

import { useEffect } from "react"
import { isTauri } from "@/lib/tauri"
import { gitWatchStart, gitWatchStop } from "@/lib/git/commands"
import { subscribeGitStatusChanged } from "@/lib/git/events"
import { loadGitRepo, refreshGitStatus } from "@/lib/git/load"
import { useProjectStore } from "@/stores/project/project-store"
import { useGitBranchInfo, useGitBusy, useGitStore } from "@/stores/git/git-store"

export interface BranchIndicator {
  available: boolean
  rootDir: string | null
  branch: string | null
  ahead: number
  behind: number
  busy: boolean
}

export function useGitBranchIndicator(): BranchIndicator {
  const available = isTauri()
  const rootDir = useGitStore((s) => s.rootDir)
  const setRootDir = useGitStore((s) => s.setRootDir)
  const branchInfo = useGitBranchInfo()
  const busy = useGitBusy()

  // Active project's on-disk root (the natural repo source).
  const activeProjectRoot = useProjectStore((s) => {
    const id = s.activeProjectId
    const project = id ? s.projects.find((p) => p.id === id) : undefined
    return project?.rootDir ?? null
  })

  // Seed the binding from the active project when nothing is bound yet.
  useEffect(() => {
    if (!available) return
    if (!rootDir && activeProjectRoot) setRootDir(activeProjectRoot)
  }, [available, rootDir, activeProjectRoot, setRootDir])

  // Own the watcher + subscription for the bound repo.
  useEffect(() => {
    if (!available || !rootDir) return undefined
    let cancelled = false

    void (async () => {
      await loadGitRepo(rootDir)
      if (cancelled) return
      await gitWatchStart(rootDir)
    })()

    const unsubscribe = subscribeGitStatusChanged((event) => {
      if (event.rootDir === rootDir) void refreshGitStatus(rootDir)
    })

    return () => {
      cancelled = true
      unsubscribe()
      void gitWatchStop(rootDir)
    }
  }, [available, rootDir])

  return {
    available,
    rootDir,
    branch: branchInfo.branch,
    ahead: branchInfo.ahead,
    behind: branchInfo.behind,
    busy,
  }
}
