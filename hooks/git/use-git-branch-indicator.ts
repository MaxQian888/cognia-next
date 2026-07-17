/**
 * useGitBranchIndicator — the always-mounted Source Control controller, driven
 * by the StatusBar. It is the single owner of the fs watcher + status-changed
 * subscription, so the branch/sync indicator stays live and the panel can rely
 * on it without managing its own watcher. Seeds the store's repo binding from
 * the active project's `rootDir` on first run.
 */

"use client"

import { useEffect } from "react"
import { gitWatchStart, gitWatchStop, isSourceControlUiAvailable } from "@/lib/git/commands"
import { subscribeGitStatusChanged } from "@/lib/git/events"
import { loadGitRepo, refreshGitStatus } from "@/lib/git/load"
import { useProjectStore } from "@/stores/project/project-store"
import { primaryRootOf } from "@/lib/workspace/roots"
import { useGitBranchInfo, useGitBusy, useGitStore } from "@/stores/git/git-store"

export interface BranchIndicator {
  available: boolean
  rootDir: string | null
  branch: string | null
  ahead: number
  behind: number
  busy: boolean
}

// The last workspace root we auto-bound the repo to. Module-scoped (NOT a
// per-mount ref) so it survives a remount of this always-mounted hook — a
// remount must not re-seed the guard to `null` and snap an ad-hoc git-panel
// rebind back to the workspace root. Reset between tests via `__resetBinding`.
let lastBoundProjectRoot: string | null = null

/** Test-only: reset the module-scoped workspace-follow guard. */
export function __resetGitIndicatorBinding(): void {
  lastBoundProjectRoot = null
}

export interface UseGitBranchIndicatorOptions {
  /** Disable controller ownership while still observing the shared store. */
  enabled?: boolean
}

export function useGitBranchIndicator({
  enabled = true,
}: UseGitBranchIndicatorOptions = {}): BranchIndicator {
  // Source Control is desktop-only for now (see `isSourceControlUiAvailable`).
  // The chip and the panel (`useGitRepo`) share this one gate, so a live chip
  // can never navigate to a dead panel.
  const available = enabled && isSourceControlUiAvailable()
  const rootDir = useGitStore((s) => s.rootDir)
  const setRootDir = useGitStore((s) => s.setRootDir)
  const branchInfo = useGitBranchInfo()
  const busy = useGitBusy()

  // Active project's primary on-disk root (the natural repo source).
  const activeProjectRoot = useProjectStore((s) => {
    const id = s.activeProjectId
    const project = id ? s.projects.find((p) => p.id === id) : undefined
    return project ? (primaryRootOf(project)?.path ?? null) : null
  })

  // Follow the active workspace: bind the repo to its `rootDir` on first sight
  // and re-bind whenever the user switches workspaces. We track the last
  // workspace root we bound (not `rootDir`) so a manual git-panel rebind to an
  // ad-hoc repo isn't snapped back — only an actual workspace switch re-binds.
  // An empty workspace root leaves the current binding untouched. The tracker
  // is module-scoped so a remount can't reset it and trigger a spurious rebind.
  useEffect(() => {
    if (!available) return
    if (activeProjectRoot && activeProjectRoot !== lastBoundProjectRoot) {
      lastBoundProjectRoot = activeProjectRoot
      setRootDir(activeProjectRoot)
    }
  }, [available, activeProjectRoot, setRootDir])

  // Own the native fs watcher + subscription for the bound repo. `available`
  // implies Tauri, so watcher start/stop are unconditional here.
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
