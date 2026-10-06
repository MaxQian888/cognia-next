"use client"

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"
import type { EvalProject, EvalReportView } from "@cognia/eval-core"
import { getEvalExecutionRuntime, type EvalExecutionRuntime } from "@/lib/ai/eval/execution-runtime"
import type { EvalReviewService } from "@/lib/ai/eval/review-service"
import {
  getActiveRuntimeTargetContext,
  subscribeRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"
import { useAccountStore } from "@/stores/account/account-store"

type Status = Awaited<ReturnType<EvalExecutionRuntime["status"]>>
const EMPTY_STATUS: Status = {
  experimentId: "",
  state: "draft",
  total: 0,
  completed: 0,
  spentCost: 0,
  reservedCost: 0,
  budgetCap: 0,
}
const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"])
const scopeSnapshot = () => {
  const scope = getActiveRuntimeTargetContext()
  return scope ? JSON.stringify(scope) : null
}
const serverScope = () => null
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

interface View {
  key: string | null
  experimentId: string | null
  status: Status
  reportView: EvalReportView | null
  reviewService: EvalReviewService | null
  error: string | null
  pending: boolean
}
const emptyView = (key: string | null): View => ({
  key,
  experimentId: null,
  status: EMPTY_STATUS,
  reportView: null,
  reviewService: null,
  error: null,
  pending: false,
})

/** A UI subscription to the scoped runtime. Unmounting never owns execution teardown. */
export function useEvalExecution() {
  const accountId = useAccountStore((state) => state.unlockedAccountId)
  const locked = useAccountStore((state) => state.locked)
  const accountRevision = useAccountStore((state) => state.accountRevision)
  const contextKey = useSyncExternalStore(subscribeRuntimeTargetContext, scopeSnapshot, serverScope)
  const scopeKey =
    !locked && contextKey && JSON.parse(contextKey).accountId === accountId
      ? `${contextKey}:${accountRevision}`
      : null
  const [binding, setBinding] = useState<{
    key: string
    contextKey: string
    revision: number
    runtime: EvalExecutionRuntime
  } | null>(null)
  const bindingRef = useRef<typeof binding>(null)
  const [view, setView] = useState<View>(() => emptyView(null))
  const selection = useRef({ id: null as string | null, generation: 0 })
  const [selectionGeneration, setSelectionGeneration] = useState(0)
  const reportRequest = useRef(0)
  const command = useRef({ token: 0, pending: false })

  const isCurrent = useCallback(
    (owner: NonNullable<typeof binding>, generation: number) =>
      bindingRef.current === owner &&
      scopeSnapshot() === owner.contextKey &&
      useAccountStore.getState().accountRevision === owner.revision &&
      !useAccountStore.getState().locked &&
      selection.current.generation === generation,
    []
  )

  const refreshReport = useCallback(async () => {
    const owner = bindingRef.current
    const { id, generation } = selection.current
    if (!owner || !id) return
    const request = ++reportRequest.current
    const report = await owner.runtime.report(id)
    if (isCurrent(owner, generation) && request === reportRequest.current) {
      setView((previous) => ({ ...previous, reportView: report }))
    }
  }, [isCurrent])

  const select = useCallback(
    async (id: string | null): Promise<boolean> => {
      const owner = bindingRef.current
      const generation = ++selection.current.generation
      selection.current.id = id
      setSelectionGeneration(generation)
      reportRequest.current += 1
      setView((previous) => ({
        ...previous,
        experimentId: id,
        status: EMPTY_STATUS,
        reportView: null,
        error: null,
      }))
      if (!id) return true
      if (!owner) return false
      try {
        const status = await owner.runtime.status(id)
        if (!isCurrent(owner, generation)) return false
        setView((previous) => ({ ...previous, status, error: status.error ?? null }))
        await refreshReport()
        return isCurrent(owner, generation)
      } catch (error) {
        if (isCurrent(owner, generation))
          setView((previous) => ({ ...previous, error: message(error) }))
        return false
      }
    },
    [isCurrent, refreshReport]
  )

  useEffect(() => {
    selection.current = { id: null, generation: selection.current.generation + 1 }
    command.current = { token: command.current.token + 1, pending: false }
    setView(emptyView(scopeKey))
    if (!scopeKey) {
      bindingRef.current = null
      setBinding(null)
      return
    }
    let owner: NonNullable<typeof binding>
    try {
      owner = {
        key: scopeKey,
        contextKey: contextKey!,
        revision: accountRevision,
        runtime: getEvalExecutionRuntime(),
      }
    } catch (error) {
      bindingRef.current = null
      setBinding(null)
      setView({ ...emptyView(scopeKey), error: message(error) })
      return
    }
    bindingRef.current = owner
    setBinding(owner)
    const generation = selection.current.generation
    void owner.runtime
      .recover()
      .then(async (rows) => {
        if (isCurrent(owner, generation) && rows[0]) await select(rows[0].experimentId)
      })
      .catch((error) => {
        if (isCurrent(owner, generation))
          setView((previous) => ({ ...previous, error: message(error) }))
      })
    return () => {
      if (bindingRef.current === owner) bindingRef.current = null
      selection.current.generation += 1
      // The runtime and its in-flight work belong to the account/target lifecycle.
    }
  }, [scopeKey, contextKey, accountRevision, isCurrent, select])

  const experimentId = view.key === scopeKey ? view.experimentId : null
  useEffect(() => {
    if (!binding || binding.key !== scopeKey || !experimentId) return
    const generation = selection.current.generation
    let active = true
    void binding.runtime
      .getReviewService()
      .then((reviewService) => {
        if (active && isCurrent(binding, generation))
          setView((previous) => ({ ...previous, reviewService }))
      })
      .catch((error) => {
        if (active && isCurrent(binding, generation))
          setView((previous) => ({ ...previous, error: message(error) }))
      })
    const unsubscribe = binding.runtime.subscribe(
      experimentId,
      (status) => {
        if (!active || !isCurrent(binding, generation)) return
        setView((previous) => ({ ...previous, status, error: status.error ?? previous.error }))
        if (TERMINAL.has(status.state))
          void refreshReport().catch((error) => {
            if (active && isCurrent(binding, generation))
              setView((previous) => ({ ...previous, error: message(error) }))
          })
      },
      (error) => {
        if (active && isCurrent(binding, generation))
          setView((previous) => ({ ...previous, error: message(error) }))
      }
    )
    return () => {
      active = false
      unsubscribe()
    }
  }, [binding, scopeKey, experimentId, selectionGeneration, isCurrent, refreshReport])

  const execute = useCallback(
    async <T>(operation: (runtime: EvalExecutionRuntime) => Promise<T>): Promise<T | undefined> => {
      const owner = bindingRef.current
      if (!owner || command.current.pending) return
      const generation = selection.current.generation
      const token = ++command.current.token
      command.current.pending = true
      setView((previous) => ({ ...previous, pending: true, error: null }))
      try {
        return await operation(owner.runtime)
      } catch (error) {
        if (isCurrent(owner, generation))
          setView((previous) => ({ ...previous, error: message(error) }))
      } finally {
        if (bindingRef.current === owner && command.current.token === token) {
          command.current.pending = false
          setView((previous) => ({ ...previous, pending: false }))
        }
      }
    },
    [isCurrent]
  )

  const start = useCallback(
    async (project: EvalProject) => {
      const owner = bindingRef.current
      const generation = selection.current.generation
      return execute(async (runtime) => {
        const id = await runtime.start(project)
        if (owner && isCurrent(owner, generation)) await select(id)
        return id
      })
    },
    [execute, isCurrent, select]
  )
  const control = useCallback(
    (action: "pause" | "resume" | "cancel", cap?: number) => {
      const { id, generation } = selection.current
      const owner = bindingRef.current
      if (!id) return Promise.resolve()
      return execute(async (runtime) => {
        if (cap !== undefined) await runtime.extendBudget(id, cap)
        else await runtime[action](id)
        const status = await runtime.status(id)
        if (owner && isCurrent(owner, generation)) setView((previous) => ({ ...previous, status }))
      })
    },
    [execute, isCurrent]
  )
  const visible = view.key === scopeKey ? view : emptyView(scopeKey)
  return {
    ...visible,
    scopeKey,
    available: Boolean(binding && binding.key === scopeKey),
    select,
    start,
    refreshReport,
    pause: useCallback(() => control("pause"), [control]),
    resume: useCallback(() => control("resume"), [control]),
    cancel: useCallback(() => control("cancel"), [control]),
    extendBudget: useCallback((cap: number) => control("pause", cap), [control]),
  }
}
