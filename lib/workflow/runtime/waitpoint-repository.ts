import type { WorkflowWaitpoint, WorkflowWaitpointRepository } from "@/types/workflow/waitpoint"
import {
  createDexieWorkflowWaitpointRepository,
  subscribeWorkflowWaitpointChanges,
} from "@/lib/db/workflow-waitpoints"

const defaultRepository = createDexieWorkflowWaitpointRepository()

export function getWorkflowWaitpointRepository(): WorkflowWaitpointRepository {
  return defaultRepository
}

export interface WaitForWorkflowWaitpointOptions {
  signal?: AbortSignal
  /** Polling also observes decisions written by another window/process mirror. */
  pollIntervalMs?: number
  cancelOnAbort?: boolean
}

function isTerminal(waitpoint: WorkflowWaitpoint): boolean {
  return waitpoint.status !== "pending"
}

/**
 * Wait for the durable row to leave `pending`. The row, not this listener, is
 * the source of truth: an already-decided checkpoint resolves immediately and
 * polling observes decisions made while this renderer was asleep.
 */
export async function waitForWorkflowWaitpoint(
  id: string,
  options: WaitForWorkflowWaitpointOptions = {}
): Promise<WorkflowWaitpoint> {
  const repository = getWorkflowWaitpointRepository()
  const initial = await repository.get(id)
  if (!initial) throw new Error(`workflow waitpoint not found: ${id}`)
  if (isTerminal(initial)) return initial

  return new Promise<WorkflowWaitpoint>((resolve, reject) => {
    let settled = false
    let deadlineHandle: ReturnType<typeof setTimeout> | undefined

    const cleanup = () => {
      off()
      if (deadlineHandle) clearTimeout(deadlineHandle)
      clearInterval(pollHandle)
      options.signal?.removeEventListener("abort", onAbort)
    }
    const finish = (waitpoint: WorkflowWaitpoint) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(waitpoint)
    }
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const settleIfTerminal = (waitpoint: WorkflowWaitpoint) => {
      if (isTerminal(waitpoint)) finish(waitpoint)
    }
    const refresh = async () => {
      try {
        const current = await repository.get(id)
        if (!current) return fail(new Error(`workflow waitpoint not found: ${id}`))
        settleIfTerminal(current)
      } catch (error) {
        fail(error)
      }
    }
    /**
     * A pushed snapshot is a HINT, never the answer: `decideWorkflowWaitpoint`
     * writes the row and only then awaits its receipt before notifying, so a
     * notification can arrive long after the row it describes was superseded —
     * or, for a deterministic id like `apr_<runId>_<stepId>`, after that row was
     * replaced by a later generation this waiter is the one actually waiting on.
     * Re-reading keeps the promise faithful to the docstring above: the row is
     * the source of truth, and this listener only says "look again".
     */
    const observe = (waitpoint: WorkflowWaitpoint) => {
      if (waitpoint.id === id && isTerminal(waitpoint)) void refresh()
    }
    const expire = async () => {
      if (settled) return
      try {
        const decision = await repository.decide(id, {
          outcome: "timed_out",
          respondedBy: "timeout",
          resolvedAt: initial.expiresAt ?? Date.now(),
        })
        if (decision.ok) return finish(decision.waitpoint)
        await refresh()
      } catch (error) {
        fail(error)
      }
    }
    const onAbort = () => {
      if (!options.cancelOnAbort) {
        fail(new Error("workflow waitpoint: aborted"))
        return
      }
      void repository
        .cancel(id, "run-cancelled")
        .then((decision) => (decision.ok ? finish(decision.waitpoint) : refresh()))
        .catch(fail)
    }

    const off = subscribeWorkflowWaitpointChanges(observe)
    const pollHandle = setInterval(
      () => void refresh(),
      Math.max(50, options.pollIntervalMs ?? 500)
    )

    if (initial.expiresAt !== undefined) {
      const remaining = initial.expiresAt - Date.now()
      if (remaining <= 0) void expire()
      else deadlineHandle = setTimeout(() => void expire(), remaining)
    }

    if (options.signal) {
      if (options.signal.aborted) onAbort()
      else options.signal.addEventListener("abort", onAbort, { once: true })
    }
  })
}
