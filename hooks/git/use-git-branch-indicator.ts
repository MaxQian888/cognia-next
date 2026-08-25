/**
 * useGitBranchIndicator — the always-mounted Source Control controller, driven
 * by the StatusBar. It is the single owner of the fs watcher + status-changed
 * subscription, so the branch/sync indicator stays live and the panel can rely
 * on it without managing its own watcher. Seeds the store's repo binding from
 * the active project's `rootDir` on first run.
 */

"use client"

import { useEffect, useMemo } from "react"
import { gitWatchStart, gitWatchStop, isSourceControlUiAvailable } from "@/lib/git/commands"
import { subscribeGitStatusChanged } from "@/lib/git/events"
import { loadGitRepo, refreshGitStatus } from "@/lib/git/load"
import { useProjectStore } from "@/stores/project/project-store"
import { resolvePanelRoot, type PanelRootTarget } from "@/lib/workspace/panel-follow"
import { useSessionExecutionContext } from "@/hooks/workspace/use-session-execution-context"
import { useChatStore } from "@/stores/chat/chat-store"
import { useGitBranchInfo, useGitBusy, useGitStore } from "@/stores/git/git-store"

export interface BranchIndicator {
  available: boolean
  rootDir: string | null
  branch: string | null
  ahead: number
  behind: number
  busy: boolean
  /** Where the panel is pointing and why — rendered by `PanelRootChip`. */
  target: PanelRootTarget
  /** Pin to the current root, or resume following the conversation. */
  togglePin: () => void
}

// The last root we auto-bound the repo to. Module-scoped (NOT a per-mount ref)
// so it survives a remount of this always-mounted hook — a remount must not
// re-seed the guard to `null` and snap an ad-hoc git-panel rebind back.
// Reset between tests via `__resetGitIndicatorBinding`.
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

  // Active workspace, as the fallback when no conversation names a root.
  const activeProject = useProjectStore((s) => {
    const id = s.activeProjectId
    return (id ? s.projects.find((p) => p.id === id) : undefined) ?? null
  })
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const pinnedRoot = useGitStore((s) => s.pinnedRoot)
  const setPinnedRoot = useGitStore((s) => s.setPinnedRoot)

  // Follow the CONVERSATION, not just the workspace. Source Control used to
  // bind to the active workspace's primary root, so a conversation working in
  // a managed worktree showed the diff of the checkout it was cut from — the
  // panel and the agent disagreed about which tree was being changed.
  //
  // Pinning is honoured because comparing is part of this panel's job ("what
  // does this look like on main"); `resolvePanelRoot` is the one place that
  // decides, so the terminal cannot accidentally acquire the same behaviour.
  const executionContext = useSessionExecutionContext(activeSessionId)
  const target = useMemo(
    () =>
      resolvePanelRoot({
        panel: "sourceControl",
        executionContext,
        activeProject,
        pinnedRoot,
      }),
    [executionContext, activeProject, pinnedRoot]
  )

  // Re-bind when the resolved target moves. The tracker holds the last target
  // we bound (not `rootDir`) so a manual git-panel rebind to an ad-hoc repo is
  // not snapped back — only an actual change of target re-binds. A target of
  // null leaves the current binding untouched.
  useEffect(() => {
    if (!available) return
    if (target.root && target.root !== lastBoundProjectRoot) {
      lastBoundProjectRoot = target.root
      setRootDir(target.root)
    }
  }, [available, target.root, setRootDir])

  // Own the native fs watcher + subscription for the bound repo. `available`
  // implies Tauri, so watcher start/stop are unconditional here.
  useEffect(() => {
    if (!available || !rootDir) return undefined
    let cancelled = false

    void (async () => {
      try {
        await loadGitRepo(rootDir)
      } catch {
        // The loader records a user-visible error. Keep starting the watcher so
        // a later filesystem change can recover the panel without a remount.
      }
      if (cancelled) return
      await gitWatchStart(rootDir).catch(() => undefined)
    })()

    const unsubscribe = subscribeGitStatusChanged((event) => {
      if (event.rootDir === rootDir) void refreshGitStatus(rootDir).catch(() => undefined)
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
    target,
    // Pin the repository actually on screen, unpin outright.
    //
    // `rootDir` rather than `target.root`: an ad-hoc rebind through
    // `RootSwitcher` is a case a pin exists for, and `rootDir` is the only
    // value that reflects one. Pinning is deliberately recorded even when it
    // equals the root being followed — that is the "freeze here" case, and it
    // does something the moment the conversation moves.
    togglePin: () => setPinnedRoot(pinnedRoot ? null : (rootDir ?? target.root)),
  }
}
