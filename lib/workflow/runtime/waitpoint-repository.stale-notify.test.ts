/**
 * The waiter must treat a pushed change as a HINT, never as the answer.
 *
 * `decideWorkflowWaitpoint` writes the row and only then awaits its
 * action-review receipt before calling `notify`, so a notification can land
 * well after the row it describes was superseded. Waitpoint ids are
 * deterministic (`apr_<runId>_<stepId>`), so "superseded" includes a later
 * generation of the same id — which is exactly how an approval step that was
 * cancelled came back reporting a timeout it never had.
 *
 * The rest of the waiter is covered by `waitpoint-repository.test.ts` against
 * the real Dexie repository. This file mocks the store so a stale push can be
 * delivered deterministically instead of raced for.
 */
import type {
  WorkflowWaitpoint,
  WorkflowWaitpointDecisionResult,
  WorkflowWaitpointRepository,
} from "@/types/workflow/waitpoint"

interface Store {
  rows: Map<string, WorkflowWaitpoint>
  listeners: Set<(waitpoint: WorkflowWaitpoint) => void>
}

/**
 * The module under test calls `createDexieWorkflowWaitpointRepository()` at
 * import time, which runs the mock factory below BEFORE any `const` in this
 * file is initialized. Everything the factory reaches must therefore be a
 * hoisted function declaration, and the state it owns has to be created on
 * first use — hence the cache parked on the function object.
 */
function store(): Store {
  const self = store as unknown as { cache?: Store }
  self.cache ??= { rows: new Map(), listeners: new Set() }
  return self.cache
}

function push(waitpoint: WorkflowWaitpoint): void {
  for (const listener of [...store().listeners]) listener(waitpoint)
}

function settle(
  id: string,
  status: WorkflowWaitpoint["status"],
  outcome: WorkflowWaitpoint["resolution"] extends infer R
    ? R extends { outcome: infer O }
      ? O
      : never
    : never,
  respondedBy: string
): WorkflowWaitpointDecisionResult {
  const current = store().rows.get(id)
  if (!current) return { ok: false, reason: "not-found" }
  if (current.status !== "pending") return { ok: false, reason: "already-decided" }
  const decided: WorkflowWaitpoint = {
    ...current,
    status,
    resolution: { outcome, respondedBy, resolvedAt: 1_000 },
    updatedAt: 1_000,
  }
  store().rows.set(id, decided)
  push(decided)
  return { ok: true, waitpoint: decided }
}

function fakeRepository(): WorkflowWaitpointRepository {
  return {
    create: async (waitpoint) => {
      store().rows.set(waitpoint.id, waitpoint)
      return waitpoint
    },
    get: async (id) => store().rows.get(id),
    listPending: async () => [...store().rows.values()].filter((w) => w.status === "pending"),
    decide: async (id, resolution) =>
      settle(
        id,
        resolution.outcome === "timed_out" ? "timed_out" : "resolved",
        resolution.outcome,
        resolution.respondedBy ?? "test"
      ),
    cancel: async (id, respondedBy) => settle(id, "cancelled", "cancelled", respondedBy),
    emit: async (event) => event,
    pruneExpiredEvents: async () => 0,
  }
}

jest.mock("@/lib/db/workflow-waitpoints", () => ({
  createDexieWorkflowWaitpointRepository: () => fakeRepository(),
  subscribeWorkflowWaitpointChanges: (listener: (w: WorkflowWaitpoint) => void) => {
    store().listeners.add(listener)
    return () => store().listeners.delete(listener)
  },
}))

import { waitForWorkflowWaitpoint } from "./waitpoint-repository"

const repository = fakeRepository()

/**
 * `generation` only distinguishes one row from its successor; the timestamps
 * must be real epoch millis, because the waiter arms its deadline against
 * `Date.now()` — a toy `createdAt` puts `expiresAt` in 1970 and every wait
 * times out before the test can push anything.
 */
function pending(id: string, generation: number): WorkflowWaitpoint {
  const createdAt = Date.now() + generation
  return {
    id,
    kind: "approval",
    status: "pending",
    runId: "run_1",
    workflowId: "wf_1",
    stepId: "step_1",
    key: `approval:${id}`,
    createdAt,
    notBefore: createdAt,
    // An hour out: nothing here should ever reach its own deadline.
    expiresAt: createdAt + 3_600_000,
    updatedAt: createdAt,
  }
}

/** Give the waiter's pushed-hint re-read a chance to run, then report. */
async function hasSettled(promise: Promise<unknown>): Promise<boolean> {
  let settled = false
  void promise.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    }
  )
  await new Promise((resolve) => setTimeout(resolve, 20))
  return settled
}

beforeEach(() => {
  store().rows.clear()
  store().listeners.clear()
})

describe("waitForWorkflowWaitpoint — stale notifications", () => {
  it("ignores a terminal push for a superseded generation of the same id", async () => {
    const id = "apr_run_1_step_1"
    // Generation 1 timed out and was cleared away; its notification is still in
    // flight behind the receipt write.
    const staleGeneration: WorkflowWaitpoint = {
      ...pending(id, 0),
      status: "timed_out",
      resolution: { outcome: "timed_out", respondedBy: "timeout", resolvedAt: 2 },
      updatedAt: 2,
    }

    // Generation 2 — a fresh pending row under the same deterministic id.
    await repository.create(pending(id, 1))
    const waiting = waitForWorkflowWaitpoint(id, { pollIntervalMs: 10_000 })
    await Promise.resolve()

    push(staleGeneration)
    // Still waiting: the stored row is pending, whatever the push claimed.
    expect(await hasSettled(waiting)).toBe(false)

    // And the real decision still lands.
    await repository.cancel(id, "run-cancelled")
    await expect(waiting).resolves.toMatchObject({
      status: "cancelled",
      resolution: { outcome: "cancelled", respondedBy: "run-cancelled" },
    })
  })

  it("settles on the stored row, not on the pushed snapshot", async () => {
    const id = "apr_run_1_step_2"
    await repository.create(pending(id, 1))
    const waiting = waitForWorkflowWaitpoint(id, { pollIntervalMs: 10_000 })
    await Promise.resolve()

    // Decide it for real, then push a contradictory snapshot for the same id.
    await repository.decide(id, {
      outcome: "approved",
      respondedBy: "device:a",
      resolvedAt: 1_000,
    })
    push({
      ...pending(id, 1),
      status: "timed_out",
      resolution: { outcome: "timed_out", respondedBy: "timeout", resolvedAt: 3 },
    })

    await expect(waiting).resolves.toMatchObject({
      status: "resolved",
      resolution: { outcome: "approved", respondedBy: "device:a" },
    })
  })

  it("ignores a push for a different waitpoint entirely", async () => {
    const id = "apr_run_1_step_3"
    await repository.create(pending(id, 1))
    const waiting = waitForWorkflowWaitpoint(id, { pollIntervalMs: 10_000 })
    await Promise.resolve()

    push({
      ...pending("apr_other", 1),
      status: "timed_out",
      resolution: { outcome: "timed_out", respondedBy: "timeout", resolvedAt: 3 },
    })
    expect(await hasSettled(waiting)).toBe(false)

    await repository.cancel(id, "run-cancelled")
    await expect(waiting).resolves.toMatchObject({ status: "cancelled" })
  })

  it("unsubscribes once it settles, so a later push cannot reach it", async () => {
    const id = "apr_run_1_step_4"
    await repository.create(pending(id, 1))
    const waiting = waitForWorkflowWaitpoint(id, { pollIntervalMs: 10_000 })
    await Promise.resolve()
    expect(store().listeners.size).toBe(1)

    await repository.cancel(id, "run-cancelled")
    await waiting
    expect(store().listeners.size).toBe(0)
  })
})
