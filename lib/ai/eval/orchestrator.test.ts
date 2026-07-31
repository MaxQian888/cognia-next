import type { EvalExperimentState, EvalTask } from "@cognia/eval-core"
import {
  DurableEvalOrchestrator,
  classifyEvalRetry,
  type EvalOrchestratorRepository,
} from "./orchestrator"

function task(overrides: Partial<EvalTask> = {}): EvalTask & { providerId: string } {
  return {
    id: "task-1",
    experimentId: "experiment-1",
    variantId: "variant-1",
    caseId: "case-1",
    repetition: 1,
    state: "queued",
    attempt: 0,
    reservedCost: 0,
    estimatedWorstCaseCost: 0.6,
    updatedAt: 1,
    providerId: "provider-a",
    ...overrides,
  }
}

function repository(
  tasks: Array<ReturnType<typeof task>>,
  cap = 1
): {
  repo: EvalOrchestratorRepository<string>
  states: EvalExperimentState[]
  spent: () => number
} {
  const rows = new Map(tasks.map((item) => [item.id, item]))
  let reserved = 0
  let spent = 0
  const states: EvalExperimentState[] = []
  return {
    states,
    spent: () => spent,
    repo: {
      getExperiment: async () => ({ state: states.at(-1) ?? "queued", hardCap: cap }),
      listTasks: async () => [...rows.values()],
      setExperimentState: async (_id, state) => void states.push(state),
      updateTask: async (id, patch) => void Object.assign(rows.get(id)!, patch),
      reserveTask: async (id, amount) => {
        const row = rows.get(id)!
        if (row.reservedCost > 0) return true
        if (reserved + spent + amount > cap) return false
        row.reservedCost = amount
        reserved += amount
        return true
      },
      completeTask: async (row, result) => {
        reserved -= row.reservedCost
        spent += result.actualCost
        Object.assign(rows.get(row.id)!, { state: "completed", reservedCost: 0 })
      },
      releaseTaskReservation: async (id) => {
        const row = rows.get(id)!
        reserved -= row.reservedCost
        row.reservedCost = 0
      },
    },
  }
}

describe("durable evaluation orchestrator", () => {
  it("persists explicit pause, resume, and cancellation commands", async () => {
    const { repo, states } = repository([task()], 1)
    const orchestrator = new DurableEvalOrchestrator(
      repo,
      async () => ({ actualCost: 0, value: "ok" }),
      { now: () => 10, sleep: async () => {} }
    )

    await orchestrator.pause("experiment-1")
    expect(states.at(-1)).toBe("paused")
    await orchestrator.resume("experiment-1")
    expect(states.at(-1)).toBe("completed")

    const active = repository([task()], 1)
    const cancelling = new DurableEvalOrchestrator(
      active.repo,
      async () => ({ actualCost: 0, value: "ok" }),
      { now: () => 10, sleep: async () => {} }
    )
    await cancelling.cancel("experiment-1")
    expect(active.states.at(-1)).toBe("cancelled")
    await cancelling.cancel("experiment-1")
  })

  it("pauses before dispatch when the next worst-case reservation exceeds the cap", async () => {
    const { repo, states } = repository([task(), task({ id: "task-2", caseId: "case-2" })], 1)
    const execute = jest.fn(async () => ({ actualCost: 0.5, value: "ok" }))
    const orchestrator = new DurableEvalOrchestrator(repo, execute, {
      now: () => 10,
      random: () => 0.5,
      sleep: async () => {},
    })

    await orchestrator.run("experiment-1")

    expect(execute).toHaveBeenCalledTimes(1)
    expect(states.at(-1)).toBe("paused")
  })

  it("respects provider-scoped concurrency while dispatching independent providers", async () => {
    const { repo, states } = repository(
      [
        task({ id: "a1" }),
        task({ id: "a2", caseId: "case-2" }),
        task({ id: "b1", caseId: "case-3", providerId: "provider-b" } as never),
      ],
      5
    )
    let activeA = 0
    let maxA = 0
    let activeTotal = 0
    let maxTotal = 0
    const execute = jest.fn(async (row: EvalTask & { providerId?: string }) => {
      if (row.providerId === "provider-a") maxA = Math.max(maxA, ++activeA)
      maxTotal = Math.max(maxTotal, ++activeTotal)
      await Promise.resolve()
      activeTotal--
      if (row.providerId === "provider-a") activeA--
      return { actualCost: 0.1, value: "ok" }
    })
    const orchestrator = new DurableEvalOrchestrator(repo, execute, {
      providerConcurrency: { "provider-a": 1, "provider-b": 1 },
      now: () => 10,
      random: () => 0.5,
      sleep: async () => {},
    })

    await orchestrator.run("experiment-1")

    expect(maxA).toBe(1)
    expect(maxTotal).toBe(2)
    expect(states.at(-1)).toBe("completed")
  })

  it("honors Retry-After and then retries without reserving the same spend twice", async () => {
    const { repo, spent } = repository([task()], 1)
    const execute = jest
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("rate limited"), { status: 429, retryAfter: 2 })
      )
      .mockResolvedValueOnce({ actualCost: 0.2, value: "ok" })
    const sleeps: number[] = []
    let now = 10
    const orchestrator = new DurableEvalOrchestrator(repo, execute, {
      now: () => now,
      random: () => 0.5,
      sleep: async (ms) => {
        sleeps.push(ms)
        now += ms
      },
    })

    await orchestrator.run("experiment-1")

    expect(execute).toHaveBeenCalledTimes(2)
    expect(sleeps).toContain(2_000)
    expect(spent()).toBe(0.2)
  })

  it("aborts an in-flight request on cancel and releases its reservation", async () => {
    const harness = repository([task()], 1)
    let started!: () => void
    const dispatched = new Promise<void>((resolve) => {
      started = resolve
    })
    const execute = jest.fn(
      async (
        _task: EvalTask,
        signal: AbortSignal
      ): Promise<{ actualCost: number; value: string }> => {
        started()
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () =>
            reject(new DOMException("cancelled", "AbortError"))
          )
        })
        return { actualCost: 0, value: "unreachable" }
      }
    )
    const orchestrator = new DurableEvalOrchestrator(harness.repo, execute, {
      now: () => 10,
      sleep: async () => {},
    })

    const running = orchestrator.run("experiment-1")
    await dispatched
    await orchestrator.cancel("experiment-1")
    await running

    expect(harness.states.at(-1)).toBe("cancelled")
    expect(harness.spent()).toBe(0)
  })

  it("lets persisted stage finalization schedule adaptive follow-up work", async () => {
    const { repo, states } = repository([task()], 1)
    const prepareNextStage = jest
      .fn<Promise<boolean>, [string]>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    repo.prepareNextStage = prepareNextStage
    const orchestrator = new DurableEvalOrchestrator(
      repo,
      async () => ({ actualCost: 0.1, value: "ok" }),
      { now: () => 10, sleep: async () => {} }
    )

    await orchestrator.run("experiment-1")

    expect(prepareNextStage).toHaveBeenCalledTimes(2)
    expect(states.at(-1)).toBe("completed")
  })

  it("rejects missing experiments and no-ops already terminal runs", async () => {
    const missing = repository([], 1)
    missing.repo.getExperiment = async () => undefined
    const orchestrator = new DurableEvalOrchestrator(missing.repo, async () => ({
      actualCost: 0,
      value: "ok",
    }))
    await expect(orchestrator.run("missing")).rejects.toThrow("not found")

    for (const state of ["completed", "cancelled", "failed"] as const) {
      missing.repo.getExperiment = async () => ({ state, hardCap: 1 })
      await expect(orchestrator.run("terminal")).resolves.toBeUndefined()
    }
  })

  it.each([
    ["failed", new Error("permanent")],
    ["interrupted", new DOMException("aborted", "AbortError")],
  ] as const)("persists a terminal %s task outcome", async (expectedState, failure) => {
    const harness = repository([task()], 1)
    const orchestrator = new DurableEvalOrchestrator(
      harness.repo,
      async () => {
        throw failure
      },
      { now: () => 10, maxAttempts: 1, sleep: async () => {} }
    )

    await orchestrator.run("experiment-1")
    expect(harness.states.at(-1)).toBe(expectedState)
  })

  it("marks an undeliverable persisted queue as interrupted instead of spinning", async () => {
    const harness = repository([task({ state: "paused" })], 1)
    const orchestrator = new DurableEvalOrchestrator(
      harness.repo,
      async () => ({ actualCost: 0, value: "ok" }),
      { now: () => 10, sleep: async () => {} }
    )

    await orchestrator.run("experiment-1")
    expect(harness.states.at(-1)).toBe("interrupted")
  })

  it("uses exponential jitter for retryable transport failures", async () => {
    const harness = repository([task()], 1)
    let now = 10
    const sleeps: number[] = []
    const execute = jest
      .fn()
      .mockRejectedValueOnce(new TypeError("network disconnected"))
      .mockResolvedValueOnce({ actualCost: 0, value: "ok" })
    const orchestrator = new DurableEvalOrchestrator(harness.repo, execute, {
      now: () => now,
      random: () => 0,
      baseRetryMs: 100,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds)
        now += milliseconds
      },
    })

    await orchestrator.run("experiment-1")
    expect(sleeps).toEqual([50])
  })
})

describe("classifyEvalRetry", () => {
  it.each([
    [408, true],
    [429, true],
    [500, true],
    [503, true],
    [400, false],
    [401, false],
  ])("classifies HTTP %s", (status, retryable) => {
    expect(classifyEvalRetry(Object.assign(new Error("request"), { status }))).toMatchObject({
      retryable,
    })
  })

  it("normalizes statusCode, retry delays, type errors, and non-Error failures", () => {
    expect(classifyEvalRetry({ statusCode: 503, retryAfter: "1.5", message: "busy" })).toEqual({
      retryable: true,
      retryAfterMs: 1_500,
      reason: "busy",
    })
    expect(classifyEvalRetry(new TypeError("offline"))).toEqual({
      retryable: true,
      reason: "offline",
    })
    expect(classifyEvalRetry("broken")).toEqual({ retryable: false, reason: "broken" })
  })
})
