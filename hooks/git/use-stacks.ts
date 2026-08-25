"use client"

/**
 * The stacks in the open repository, and the three things a person does to one.
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
 */

import { useCallback, useEffect, useMemo, useState } from "react"

import { discoverStacks } from "@/lib/stack/discover"
import type { Stack } from "@/lib/stack/model"
import { restackStack, type RestackStackResult } from "@/lib/stack/restack"
import { validateStack, type StackVerdict } from "@/lib/stack/validate"
import type { GitStackLayerState } from "@/types/git"

export interface StackRow {
  stack: Stack
  verdict: StackVerdict
  /** Per-branch truth, so a row can point at the layer that is wrong. */
  states: GitStackLayerState[]
}

export interface UseStacksDeps {
  discover(repositoryRoot: string): Promise<Stack[]>
  validate(repositoryRoot: string, branches: string[]): Promise<GitStackLayerState[]>
  restack(stack: Stack, remote?: string): Promise<RestackStackResult>
  setParent(repositoryRoot: string, branch: string, parent: string | null): Promise<void>
}

const DEFAULT_DEPS: UseStacksDeps = {
  discover: (repositoryRoot) => discoverStacks({ repositoryRoot }),
  validate: async (repositoryRoot, branches) => {
    const { gitStackValidate } = await import("@/lib/git/commands")
    return gitStackValidate(repositoryRoot, branches)
  },
  restack: (stack, remote) => restackStack({ stack, ...(remote ? { remote } : {}) }),
  setParent: async (repositoryRoot, branch, parent) => {
    const { gitStackSetParent } = await import("@/lib/git/commands")
    return gitStackSetParent(repositoryRoot, branch, parent)
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
  restack: (stack: Stack, remote?: string) => Promise<RestackStackResult | null>
  /** Record or clear a branch's parent — this is how a stack gets built. */
  setParent: (branch: string, parent: string | null) => Promise<void>
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
        rows.push({ stack, states, verdict: validateStack({ stack, states }) })
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
    async (stack: Stack, remote?: string) => {
      if (!root) return null
      const resolved: UseStacksDeps = { ...DEFAULT_DEPS, ...deps }
      setBusy(stack.id)
      try {
        const result = await resolved.restack(stack, remote)
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

  return {
    rows,
    loading: Boolean(root) && !settledForKey,
    busy,
    lastResult,
    refresh,
    restack,
    setParent,
  }
}
