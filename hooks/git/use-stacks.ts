"use client"

/**
 * The stacks in the open repository, and the things a person does to one.
 *
 * There is no stack table to read: the parent pointers in git config are the
 * record, and `discoverStacks` walks them. That means this hook re-reads git
 * rather than a cache, and a stack created in a terminal — or on another
 * machine, after a pull — shows up here without anything having to sync.
 *
 * Validation is a second read, per stack, because a stack that LOOKS fine and
 * is not is the failure this whole subsystem exists to prevent. It is what
 * decides whether the panel offers "restack" or tells the user to close a
 * worktree first.
 *
 * The previous tips are a third read, one `for-each-ref` per branch. It buys
 * an undo that survives a reload: a restack pins every branch's old tip under
 * `refs/cognia/stack-history/` before moving it, and an undo that is only
 * offered in the toast of the restack that caused it is not an undo — the
 * moment someone needs it most is after they have closed the panel and looked
 * at the damage.
 */

import { useCallback, useEffect, useMemo, useState } from "react"

import { discoverStacks } from "@/lib/stack/discover"
import type { Stack } from "@/lib/stack/model"
import {
  restackStack,
  type RestackAnnouncement,
  type RestackStackResult,
} from "@/lib/stack/restack"
import { validateStack, type StackVerdict } from "@/lib/stack/validate"
import type { GitStackLayerState } from "@/types/git"

/** A tip a restack pinned before moving the branch off it. */
export interface StackHistoryEntry {
  /** Full ref under `refs/cognia/stack-history/`, newest first. */
  ref: string
  oid: string
}

export interface StackRow {
  stack: Stack
  verdict: StackVerdict
  /** Per-branch truth, so a row can point at the layer that is wrong. */
  states: GitStackLayerState[]
  /** Previous tips per branch, newest first. Empty when nothing moved it. */
  history: Record<string, StackHistoryEntry[]>
}

/** How a restack is run: locally, or pushed with a note on each pull request. */
export interface RestackOptions {
  /** Push the moved branches here. Omit for a local-only restack. */
  remote?: string
  /** Told what moved, after the push. */
  announce?: (updates: readonly RestackAnnouncement[]) => Promise<void>
}

export interface UseStacksDeps {
  discover(repositoryRoot: string): Promise<Stack[]>
  validate(repositoryRoot: string, branches: string[]): Promise<GitStackLayerState[]>
  restack(stack: Stack, options: RestackOptions): Promise<RestackStackResult>
  setParent(repositoryRoot: string, branch: string, parent: string | null): Promise<void>
  /** Previously pinned tips for a branch, newest first, as `[ref, oid]`. */
  history(repositoryRoot: string, branch: string): Promise<Array<[string, string]>>
  /** Put a branch back on a pinned tip. */
  revert(repositoryRoot: string, branch: string, historyRef: string): Promise<string>
}

const DEFAULT_DEPS: UseStacksDeps = {
  discover: (repositoryRoot) => discoverStacks({ repositoryRoot }),
  validate: async (repositoryRoot, branches) => {
    const { gitStackValidate } = await import("@/lib/git/commands")
    return gitStackValidate(repositoryRoot, branches)
  },
  restack: (stack, options) =>
    restackStack({
      stack,
      ...(options.remote ? { remote: options.remote } : {}),
      ...(options.announce ? { announce: options.announce } : {}),
    }),
  setParent: async (repositoryRoot, branch, parent) => {
    const { gitStackSetParent } = await import("@/lib/git/commands")
    return gitStackSetParent(repositoryRoot, branch, parent)
  },
  history: async (repositoryRoot, branch) => {
    const { gitStackHistory } = await import("@/lib/git/commands")
    return gitStackHistory(repositoryRoot, branch)
  },
  revert: async (repositoryRoot, branch, historyRef) => {
    const { gitStackRevert } = await import("@/lib/git/commands")
    return gitStackRevert(repositoryRoot, branch, historyRef)
  },
}

export interface UseStacksResult {
  rows: StackRow[]
  loading: boolean
  /** Id of the stack currently being acted on, or null. */
  busy: string | null
  /** The last action's outcome, for a surface that reports rather than toasts. */
  lastResult: RestackStackResult | null
  refresh: () => void
  restack: (stack: Stack, options?: RestackOptions) => Promise<RestackStackResult | null>
  /** Record or clear a branch's parent — this is how a stack gets built. */
  setParent: (branch: string, parent: string | null) => Promise<void>
  /**
   * Put a branch back on a tip a restack pinned.
   *
   * Local only, deliberately. The remote still holds the restacked commits, so
   * an undo that also force-pushed would be a second rewrite on top of the
   * first — publish is where the user says that out loud.
   */
  undo: (branch: string, historyRef: string) => Promise<void>
}

export function useStacks(
  repositoryRoot: string | null | undefined,
  deps?: Partial<UseStacksDeps>
): UseStacksResult {
  const root = repositoryRoot?.trim() ?? ""
  const [nonce, setNonce] = useState(0)
  const [settled, setSettled] = useState<{ key: string; rows: StackRow[] } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [lastResult, setLastResult] = useState<RestackStackResult | null>(null)
  const requestKey = `${root}|${nonce}`

  useEffect(() => {
    if (!root) return
    let cancelled = false
    const resolved: UseStacksDeps = { ...DEFAULT_DEPS, ...deps }
    void (async () => {
      const stacks = await resolved.discover(root).catch(() => [] as Stack[])
      const rows: StackRow[] = []
      for (const stack of stacks) {
        const branches = [...stack.layers]
          .sort((left, right) => left.order - right.order)
          .map((layer) => layer.branch)
        const states = await resolved
          .validate(root, branches)
          .catch(() => [] as GitStackLayerState[])
        // Best effort per branch: a repository with no pinned tips answers
        // with an empty list, and a client with no git bridge answers the same
        // way. Neither is a reason to withhold the stack itself.
        const pinned = await Promise.all(
          branches.map(async (branch) => {
            const entries = await resolved
              .history(root, branch)
              .catch(() => [] as Array<[string, string]>)
            return [branch, entries.map(([ref, oid]) => ({ ref, oid }))] as const
          })
        )
        rows.push({
          stack,
          states,
          verdict: validateStack({ stack, states }),
          history: Object.fromEntries(pinned),
        })
      }
      if (!cancelled) setSettled({ key: requestKey, rows })
    })()
    return () => {
      cancelled = true
    }
    // `deps` is a test seam and stable in production; an inline object would
    // re-read git on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey, root])

  const settledForKey = settled?.key === requestKey ? settled : null
  const rows = useMemo(() => settledForKey?.rows ?? [], [settledForKey])

  const refresh = useCallback(() => setNonce((value) => value + 1), [])

  const restack = useCallback(
    async (stack: Stack, options: RestackOptions = {}) => {
      if (!root) return null
      const resolved: UseStacksDeps = { ...DEFAULT_DEPS, ...deps }
      setBusy(stack.id)
      try {
        const result = await resolved.restack(stack, options)
        setLastResult(result)
        return result
      } finally {
        setBusy(null)
        // Always re-read: a refused restack changed nothing but a conflicted
        // one moved some layers, and the panel must not claim otherwise.
        setNonce((value) => value + 1)
      }
    },
    [root, deps]
  )

  const setParent = useCallback(
    async (branch: string, parent: string | null) => {
      if (!root) return
      const resolved: UseStacksDeps = { ...DEFAULT_DEPS, ...deps }
      setBusy(branch)
      try {
        await resolved.setParent(root, branch, parent)
      } finally {
        setBusy(null)
        setNonce((value) => value + 1)
      }
    },
    [root, deps]
  )

  const undo = useCallback(
    async (branch: string, historyRef: string) => {
      if (!root) return
      const resolved: UseStacksDeps = { ...DEFAULT_DEPS, ...deps }
      setBusy(branch)
      try {
        await resolved.revert(root, branch, historyRef)
      } finally {
        setBusy(null)
        setNonce((value) => value + 1)
      }
    },
    [root, deps]
  )

  return {
    rows,
    loading: Boolean(root) && !settledForKey,
    busy,
    lastResult,
    refresh,
    restack,
    setParent,
    undo,
  }
}
