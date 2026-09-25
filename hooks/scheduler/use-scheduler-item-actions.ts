"use client"

/**
 * Run now / pause / resume / delete for any scheduled item, with an honest
 * answer every time.
 *
 * Both scheduler pages carried their own copy of this and both reported
 * failures only when a promise rejected. The app store answers "no" by
 * returning `false` / `null` rather than throwing, so a refused pause, a run
 * of a task that no longer existed and a failed delete all looked like
 * success, and success itself said nothing at all.
 *
 * Run now does not wait for the run: `TaskScheduler.runTaskNow` resolves when
 * the run FINISHES, which for an agent turn is minutes. The item is marked
 * `starting` until its run shows up as running (or a short grace period
 * passes), a single toast follows it from "starting" to "started", and it
 * only speaks again if the run fails, with a way to open that run.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { getSchedulerSourceRegistry } from "@/lib/scheduler/sources/registry"
import { useSchedulerStore } from "@/stores/scheduler/scheduler-store"
import type { ScheduledTask, TaskExecution } from "@/types/scheduler"
import { makeUnifiedId, type UnifiedScheduledItem } from "@/types/scheduler/unified"
import type { UnifiedExecutionRun } from "@/types/scheduler/unified-runs"

/** Kinds whose rows are `ScheduledTask`s in the app scheduler's own table. */
const APP_TABLE_KINDS: ReadonlySet<string> = new Set(["app", "plugin", "connector"])

export function isAppTableKind(kind: string | null | undefined): boolean {
  return Boolean(kind && APP_TABLE_KINDS.has(kind))
}

/** How long "starting" may last before the run is assumed under way. */
export const RUN_STARTING_GRACE_MS = 3_000

export type PendingItemAction = "starting" | "pausing" | "resuming" | "deleting"

/**
 * Whether a task's own notification will already say how a run ended, in a
 * toast (`notification-integration.ts` reads the same fields). Run now then
 * stays quiet about that outcome instead of saying it twice.
 */
export function taskAnnouncesOutcome(
  task: Pick<ScheduledTask, "notification"> | undefined,
  outcome: "complete" | "error"
): boolean {
  const notification = task?.notification
  if (!notification || !(notification.channels ?? []).includes("toast")) return false
  return outcome === "complete" ? notification.onComplete : notification.onError
}

export interface SchedulerItemActionsDeps {
  runTaskNow: (taskId: string) => Promise<TaskExecution | null>
  pauseTask: (taskId: string) => Promise<boolean>
  resumeTask: (taskId: string) => Promise<boolean>
  deleteTask: (taskId: string) => Promise<boolean>
  /** Recent runs across kinds; a running one for the item ends `starting`. */
  runs: readonly UnifiedExecutionRun[]
  /** Opens a run's sheet by its unified id. */
  onOpenRun?: (runUnifiedId: string) => void
  /** The item's own notification already toasts this outcome (see {@link taskAnnouncesOutcome}). */
  announcesOutcome?: (item: UnifiedScheduledItem, outcome: "complete" | "error") => boolean
  /** Injected in tests. */
  registry?: ReturnType<typeof getSchedulerSourceRegistry>
}

export interface SchedulerItemActions {
  /** In-flight action per `unifiedId`. */
  pending: Readonly<Record<string, PendingItemAction>>
  runNow: (item: UnifiedScheduledItem) => void
  pause: (item: UnifiedScheduledItem) => void
  resume: (item: UnifiedScheduledItem) => void
  /** Delete without asking; the caller owns the confirmation. Resolves true on success. */
  remove: (item: UnifiedScheduledItem) => Promise<boolean>
}

function describe(error: unknown): string | undefined {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  return undefined
}

/** The store's own account of the last refusal, read right after it happened. */
function storeError(): string | undefined {
  return useSchedulerStore.getState().error ?? undefined
}

export function useSchedulerItemActions(deps: SchedulerItemActionsDeps): SchedulerItemActions {
  const t = useTranslations("scheduler")
  const tActions = useTranslations("scheduler.itemActions")
  const [pending, setPending] = useState<Record<string, PendingItemAction>>({})
  // Per-item bookkeeping for a starting run: its toast and its grace timer.
  const starting = useRef(new Map<string, { toastId: string | number; timer: number }>())
  const {
    runTaskNow,
    pauseTask,
    resumeTask,
    deleteTask,
    runs,
    onOpenRun,
    announcesOutcome,
    registry,
  } = deps

  const setItemPending = useCallback((id: string, action: PendingItemAction | null) => {
    setPending((prev) => {
      if (action === null) {
        if (!(id in prev)) return prev
        const next = { ...prev }
        delete next[id]
        return next
      }
      return prev[id] === action ? prev : { ...prev, [id]: action }
    })
  }, [])

  const viewRunAction = useCallback(
    (runUnifiedId: string) =>
      onOpenRun
        ? { label: tActions("viewRun"), onClick: () => onOpenRun(runUnifiedId) }
        : undefined,
    [onOpenRun, tActions]
  )

  /** End `starting`: the run is visibly under way, or the grace period ran out. */
  const settleStarting = useCallback(
    (item: UnifiedScheduledItem, runUnifiedId?: string) => {
      const entry = starting.current.get(item.unifiedId)
      if (!entry) return
      window.clearTimeout(entry.timer)
      starting.current.delete(item.unifiedId)
      setItemPending(item.unifiedId, null)
      toast.success(tActions("started", { name: item.name }), {
        id: entry.toastId,
        ...(runUnifiedId ? { action: viewRunAction(runUnifiedId) } : {}),
      })
    },
    [setItemPending, tActions, viewRunAction]
  )

  // A running run for a starting item is the signal that it started.
  const startingItems = useRef(new Map<string, UnifiedScheduledItem>())
  useEffect(() => {
    if (startingItems.current.size === 0) return
    for (const [id, item] of startingItems.current) {
      const run = runs.find(
        (candidate) => candidate.itemUnifiedId === id && candidate.status === "running"
      )
      if (run) {
        startingItems.current.delete(id)
        settleStarting(item, run.unifiedId)
      }
    }
  }, [runs, settleStarting])

  // Timers must not fire into an unmounted page.
  useEffect(() => {
    const entries = starting.current
    return () => {
      for (const entry of entries.values()) window.clearTimeout(entry.timer)
      entries.clear()
    }
  }, [])

  const fail = useCallback(
    (item: UnifiedScheduledItem, description?: string, id?: string | number) => {
      toast.error(t("actionFailed", { name: item.name }), {
        ...(id !== undefined ? { id } : {}),
        ...(description ? { description } : {}),
      })
    },
    [t]
  )

  const resolveSource = useCallback(
    (item: UnifiedScheduledItem) => (registry ?? getSchedulerSourceRegistry()).getSource(item.kind),
    [registry]
  )

  const runNow = useCallback(
    (item: UnifiedScheduledItem) => {
      const id = item.unifiedId
      if (starting.current.has(id)) return
      const toastId = toast.loading(tActions("starting", { name: item.name }))
      const timer = window.setTimeout(() => {
        startingItems.current.delete(id)
        settleStarting(item)
      }, RUN_STARTING_GRACE_MS)
      starting.current.set(id, { toastId, timer })
      startingItems.current.set(id, item)
      setItemPending(id, "starting")

      const clearStarting = () => {
        const entry = starting.current.get(id)
        if (entry) window.clearTimeout(entry.timer)
        starting.current.delete(id)
        startingItems.current.delete(id)
        setItemPending(id, null)
      }

      if (isAppTableKind(item.kind)) {
        void runTaskNow(item.sourceId)
          .then((execution) => {
            const stillStarting = starting.current.has(id)
            clearStarting()
            if (!execution) {
              fail(item, storeError(), toastId)
              return
            }
            // Held by the overlap policy behind a run in flight: nothing ran
            // yet, and the id is a placeholder no run sheet can open.
            if (execution.status === "pending") {
              toast.info(tActions("queued", { name: item.name }), { id: toastId })
              return
            }
            const runUnifiedId = makeUnifiedId(item.kind, execution.id)
            // Turned away before it ran (overlap skip, host cap) or stopped:
            // neither is a finished run, and no task notification says so.
            if (execution.status === "skipped" || execution.status === "cancelled") {
              const reason = execution.logs?.at(-1)?.message
              toast.warning(
                tActions(execution.status === "skipped" ? "skipped" : "cancelled", {
                  name: item.name,
                }),
                {
                  id: toastId,
                  ...(reason ? { description: reason } : {}),
                  action: viewRunAction(runUnifiedId),
                }
              )
              return
            }
            const outcome = execution.status === "failed" ? "error" : "complete"
            if (announcesOutcome?.(item, outcome) && (outcome === "error" || stillStarting)) {
              // The task's own notification says it; one toast, not two.
              toast.dismiss(toastId)
              return
            }
            if (execution.status === "failed") {
              toast.error(tActions("runFailed", { name: item.name }), {
                id: toastId,
                ...(execution.error ? { description: execution.error } : {}),
                action: viewRunAction(runUnifiedId),
              })
            } else if (stillStarting) {
              // Finished before it was ever seen running: say it is done.
              toast.success(tActions("finished", { name: item.name }), {
                id: toastId,
                action: viewRunAction(runUnifiedId),
              })
            }
          })
          .catch((error: unknown) => {
            clearStarting()
            fail(item, describe(error), toastId)
          })
        return
      }

      const source = resolveSource(item)
      if (!source) {
        clearStarting()
        fail(item, undefined, toastId)
        return
      }
      void source
        .runNow(item.sourceId)
        .then(() => {
          if (starting.current.has(id)) {
            clearStarting()
            toast.success(tActions("started", { name: item.name }), { id: toastId })
          }
        })
        .catch((error: unknown) => {
          clearStarting()
          fail(item, describe(error), toastId)
        })
    },
    [
      announcesOutcome,
      fail,
      resolveSource,
      runTaskNow,
      setItemPending,
      settleStarting,
      tActions,
      viewRunAction,
    ]
  )

  const toggle = useCallback(
    (item: UnifiedScheduledItem, action: "pause" | "resume") => {
      const id = item.unifiedId
      setItemPending(id, action === "pause" ? "pausing" : "resuming")
      const done = tActions(action === "pause" ? "paused" : "resumed", { name: item.name })
      const attempt: Promise<void> = isAppTableKind(item.kind)
        ? (action === "pause" ? pauseTask : resumeTask)(item.sourceId).then((ok) => {
            if (!ok) throw new Error(storeError() ?? "")
          })
        : (() => {
            const source = resolveSource(item)
            return source ? source[action](item.sourceId) : Promise.reject(new Error(""))
          })()
      void attempt
        .then(() => toast.success(done))
        .catch((error: unknown) => fail(item, describe(error) || undefined))
        .finally(() => setItemPending(id, null))
    },
    [fail, pauseTask, resolveSource, resumeTask, setItemPending, tActions]
  )

  const pause = useCallback((item: UnifiedScheduledItem) => toggle(item, "pause"), [toggle])
  const resume = useCallback((item: UnifiedScheduledItem) => toggle(item, "resume"), [toggle])

  const remove = useCallback(
    async (item: UnifiedScheduledItem): Promise<boolean> => {
      const id = item.unifiedId
      setItemPending(id, "deleting")
      try {
        if (isAppTableKind(item.kind)) {
          const ok = await deleteTask(item.sourceId)
          if (!ok) throw new Error(storeError() ?? "")
        } else {
          const source = resolveSource(item)
          if (!source) throw new Error("")
          await source.delete(item.sourceId)
        }
        toast.success(tActions("deleted", { name: item.name }))
        return true
      } catch (error) {
        fail(item, describe(error) || undefined)
        return false
      } finally {
        setItemPending(id, null)
      }
    },
    [deleteTask, fail, resolveSource, setItemPending, tActions]
  )

  return { pending, runNow, pause, resume, remove }
}
