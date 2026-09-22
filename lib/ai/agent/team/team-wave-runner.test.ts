import { runTeamWaves } from "./team-wave-runner"
import type { TeamRunContext } from "./team-run-context"
import type { AgentTeamTask } from "@/types/agent/agent-team"
import type { VisualWorkflow } from "@/types/workflow/visual"
import type { RunWorkflowResult } from "@/lib/workflow/runtime/orchestrator"

const task = (id: string, deps: string[] = []): AgentTeamTask =>
  ({
    id,
    teamId: "team1",
    title: id,
    description: `desc ${id}`,
    status: "pending",
    priority: "normal",
    dependencies: deps,
    tags: [],
    createdAt: new Date(),
    order: 0,
  }) as AgentTeamTask

function makeCtx() {
  return {
    runId: "run1",
    teamId: "team1",
    team: { id: "team1", name: "Team", description: "" },
  } as unknown as TeamRunContext
}

const ok = (): RunWorkflowResult => ({ runId: "run1", status: "succeeded" })

describe("runTeamWaves", () => {
  it("rejects a disconnected cycle before running an otherwise ready task", async () => {
    const runWave = jest.fn(async () => ok())
    const result = await runTeamWaves({
      teamCtx: makeCtx(),
      tasks: [task("ready"), task("a", ["b"]), task("b", ["a"])],
      initialConcurrency: 1,
      signal: new AbortController().signal,
      runWave,
    })
    expect(result.status).toBe("failed")
    expect(result.error?.message).toMatch(/cycle/)
    expect(runWave).not.toHaveBeenCalled()
  })

  it("does not reinterpret a cancelled prerequisite as successful", async () => {
    const runWave = jest.fn(async () => ok())
    const result = await runTeamWaves({
      teamCtx: makeCtx(),
      tasks: [task("a"), task("b", ["a"]), task("c", ["b"])],
      initialConcurrency: 1,
      signal: new AbortController().signal,
      runWave,
      checkpoint: async ({ remaining }) => ({
        remaining: remaining.filter((item) => item.id !== "b"),
        finish: false,
        decision: {
          action: "cancel",
          reasoning: "",
          newTasks: [],
          cancelTaskIds: ["b"],
          reorderTaskIds: [],
          newMembers: [],
        },
      }),
    })
    expect(result.status).toBe("failed")
    expect(runWave).toHaveBeenCalledTimes(1)
  })

  it("honors cancellation even under errorPolicy continue", async () => {
    const runWave = jest.fn(async (): Promise<RunWorkflowResult> => ({
      runId: "run1",
      status: "cancelled",
    }))
    const result = await runTeamWaves({
      teamCtx: makeCtx(),
      tasks: [task("a"), task("b", ["a"])],
      initialConcurrency: 1,
      signal: new AbortController().signal,
      runWave,
      errorPolicy: "continue",
    })
    expect(result.status).toBe("cancelled")
    expect(runWave).toHaveBeenCalledTimes(1)
  })

  it("rejects unknown dependencies before dispatching any wave", async () => {
    const runWave = jest.fn(async () => ok())
    const result = await runTeamWaves({
      teamCtx: makeCtx(),
      tasks: [task("a", ["missing"])],
      initialConcurrency: 1,
      signal: new AbortController().signal,
      runWave,
    })
    expect(result.status).toBe("failed")
    expect(result.error?.message).toMatch(/unknown task/)
    expect(runWave).not.toHaveBeenCalled()
  })

  it("accepts only explicitly satisfied dependencies from prior execution", async () => {
    const runWave = jest.fn(async () => ok())
    const result = await runTeamWaves({
      teamCtx: makeCtx(),
      tasks: [task("a", ["prior"])],
      satisfiedDependencyIds: new Set(["prior"]),
      initialConcurrency: 1,
      signal: new AbortController().signal,
      runWave,
    })
    expect(result.status).toBe("succeeded")
    expect(runWave).toHaveBeenCalledTimes(1)
  })

  it("uses one deadline across waves and checkpoints", async () => {
    jest.useFakeTimers()
    try {
      const timeouts: number[] = []
      const result = runTeamWaves({
        teamCtx: makeCtx(),
        tasks: [task("a"), task("b", ["a"])],
        initialConcurrency: 1,
        wallClockTimeoutMs: 100,
        signal: new AbortController().signal,
        runWave: async (workflow, signal) => {
          timeouts.push(workflow.settings.timeoutMs)
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 60)
            signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer)
                resolve()
              },
              { once: true }
            )
          })
          return signal.aborted ? { runId: "run1", status: "cancelled" } : ok()
        },
        checkpoint: async ({ remaining }) => ({
          remaining,
          finish: false,
          decision: {
            action: "continue",
            reasoning: "",
            newTasks: [],
            cancelTaskIds: [],
            reorderTaskIds: [],
            newMembers: [],
          },
        }),
      })
      await jest.advanceTimersByTimeAsync(100)
      expect((await result).error?.code).toBe("timeout")
      expect(timeouts).toEqual([100, 40])
    } finally {
      jest.useRealTimers()
    }
  })

  it("expires the same deadline during checkpoint work before another wave starts", async () => {
    jest.useFakeTimers()
    try {
      const runWave = jest.fn(async () => ok())
      const result = runTeamWaves({
        teamCtx: makeCtx(),
        tasks: [task("a"), task("b", ["a"])],
        initialConcurrency: 1,
        wallClockTimeoutMs: 100,
        signal: new AbortController().signal,
        runWave,
        checkpoint: ({ signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true })
          }),
      })
      await jest.advanceTimersByTimeAsync(100)
      expect(await result).toMatchObject({ status: "failed", error: { code: "timeout" } })
      expect(runWave).toHaveBeenCalledTimes(1)
    } finally {
      jest.useRealTimers()
    }
  })

  it("runs a single wave for independent tasks", async () => {
    const seen: VisualWorkflow[] = []
    const res = await runTeamWaves({
      teamCtx: makeCtx(),
      tasks: [task("a"), task("b")],
      initialConcurrency: 2,
      signal: new AbortController().signal,
      runWave: async (wf) => {
        seen.push(wf)
        return ok()
      },
    })
    expect(res.status).toBe("succeeded")
    expect(res.waves).toBe(1)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.nodes.map((n) => n.id).sort()).toEqual(["a", "b"])
  })

  it("splits a dependency chain into ordered waves with no checkpoint change", async () => {
    const seen: VisualWorkflow[] = []
    const checkpoint = jest.fn(async ({ remaining }) => ({
      remaining,
      finish: false,
      decision: {
        action: "continue" as const,
        reasoning: "x",
        newTasks: [],
        cancelTaskIds: [],
        reorderTaskIds: [],
        newMembers: [],
      },
    }))
    const res = await runTeamWaves({
      teamCtx: makeCtx(),
      tasks: [task("t1"), task("t2", ["t1"])],
      initialConcurrency: 2,
      signal: new AbortController().signal,
      runWave: async (wf) => {
        seen.push(wf)
        return ok()
      },
      checkpoint,
    })
    expect(res.status).toBe("succeeded")
    expect(res.waves).toBe(2)
    expect(seen[0]!.nodes.map((n) => n.id)).toEqual(["t1"])
    expect(seen[1]!.nodes.map((n) => n.id)).toEqual(["t2"])
    // Wave 2: t1 is an external satisfied dep → no scheduling edge.
    expect(seen[1]!.edges).toHaveLength(0)
    // Checkpoint runs after every wave (incl. the final empty one).
    expect(checkpoint).toHaveBeenCalledTimes(2)
    expect(checkpoint.mock.calls[0]![0].justRanTaskIds).toEqual(["t1"])
    expect(checkpoint.mock.calls[0]![0].remaining.map((t: AgentTeamTask) => t.id)).toEqual(["t2"])
  })

  it("runs an injected task in a later wave", async () => {
    const seen: VisualWorkflow[] = []
    const injected = task("injected", ["t1"])
    let injectedOnce = false
    const checkpoint = jest.fn(async ({ remaining }) => {
      const next = injectedOnce ? remaining : [...remaining, injected]
      injectedOnce = true
      return {
        remaining: next,
        finish: false,
        decision: {
          action: "inject" as const,
          reasoning: "x",
          newTasks: [],
          cancelTaskIds: [],
          reorderTaskIds: [],
          newMembers: [],
        },
      }
    })
    const res = await runTeamWaves({
      teamCtx: makeCtx(),
      tasks: [task("t1")],
      initialConcurrency: 1,
      signal: new AbortController().signal,
      runWave: async (wf) => {
        seen.push(wf)
        return ok()
      },
      checkpoint,
    })
    expect(res.waves).toBe(2)
    expect(seen[1]!.nodes.map((n) => n.id)).toEqual(["injected"])
  })

  it("stops early when the checkpoint finishes", async () => {
    const seen: VisualWorkflow[] = []
    const res = await runTeamWaves({
      teamCtx: makeCtx(),
      tasks: [task("t1"), task("t2", ["t1"])],
      initialConcurrency: 1,
      signal: new AbortController().signal,
      runWave: async (wf) => {
        seen.push(wf)
        return ok()
      },
      checkpoint: async ({ remaining }) => ({
        remaining,
        finish: true,
        decision: {
          action: "finish" as const,
          reasoning: "done",
          newTasks: [],
          cancelTaskIds: [],
          reorderTaskIds: [],
          newMembers: [],
        },
      }),
    })
    expect(res.status).toBe("succeeded")
    expect(res.waves).toBe(1) // only the first wave ran; finish stopped it
    expect(seen).toHaveLength(1)
  })

  it("stops on a failed wave under errorPolicy=stop", async () => {
    const res = await runTeamWaves({
      teamCtx: makeCtx(),
      tasks: [task("t1"), task("t2", ["t1"])],
      initialConcurrency: 1,
      signal: new AbortController().signal,
      runWave: async () => ({ runId: "run1", status: "failed", error: { message: "boom" } }),
    })
    expect(res.status).toBe("failed")
    expect(res.error?.message).toBe("boom")
    expect(res.waves).toBe(1)
  })

  it("returns cancelled when the signal is already aborted", async () => {
    const ac = new AbortController()
    ac.abort()
    const res = await runTeamWaves({
      teamCtx: makeCtx(),
      tasks: [task("t1")],
      initialConcurrency: 1,
      signal: ac.signal,
      runWave: async () => ok(),
    })
    expect(res.status).toBe("cancelled")
    expect(res.waves).toBe(0)
  })

  it("fails when remaining tasks form an unsatisfiable cycle", async () => {
    const res = await runTeamWaves({
      teamCtx: makeCtx(),
      tasks: [task("t1", ["t2"]), task("t2", ["t1"])],
      initialConcurrency: 1,
      signal: new AbortController().signal,
      runWave: async () => ok(),
    })
    expect(res.status).toBe("failed")
    expect(res.error?.message).toMatch(/cycle/)
  })

  it("fails when the synthesizer throws for a wave", async () => {
    const res = await runTeamWaves({
      teamCtx: makeCtx(),
      tasks: [task("t1")],
      initialConcurrency: 1,
      wallClockTimeoutMs: 30_000,
      signal: new AbortController().signal,
      runWave: async () => ok(),
      synthesize: () => {
        throw new Error("synth boom")
      },
    })
    expect(res.status).toBe("failed")
    expect(res.error?.message).toBe("synth boom")
    expect(res.waves).toBe(0)
  })

  it("threads wallClockTimeoutMs into the synthesized wave", async () => {
    let seenTimeout: number | undefined
    await runTeamWaves({
      teamCtx: makeCtx(),
      tasks: [task("t1")],
      initialConcurrency: 1,
      wallClockTimeoutMs: 45_000,
      signal: new AbortController().signal,
      runWave: async () => ok(),
      synthesize: (input) => {
        seenTimeout = input.wallClockTimeoutMs
        return {
          workflow: { id: "w", nodes: [], edges: [] } as unknown as VisualWorkflow,
          nodeIdToTaskId: new Map(),
        }
      },
      checkpoint: async ({ remaining }) => ({
        remaining,
        finish: false,
        decision: {
          action: "continue" as const,
          reasoning: "x",
          newTasks: [],
          cancelTaskIds: [],
          reorderTaskIds: [],
          newMembers: [],
        },
      }),
    })
    expect(seenTimeout).toBe(45_000)
  })

  it("returns the failed wave's lastResult and error", async () => {
    const res = await runTeamWaves({
      teamCtx: makeCtx(),
      tasks: [task("t1")],
      initialConcurrency: 1,
      signal: new AbortController().signal,
      runWave: async () => ({ runId: "run1", status: "cancelled", error: { message: "stopped" } }),
    })
    expect(res.status).toBe("cancelled")
    expect(res.lastResult?.status).toBe("cancelled")
    expect(res.error?.message).toBe("stopped")
  })

  it("treats a checkpoint throw as fail-open continue", async () => {
    let calls = 0
    const res = await runTeamWaves({
      teamCtx: makeCtx(),
      tasks: [task("t1"), task("t2", ["t1"])],
      initialConcurrency: 1,
      signal: new AbortController().signal,
      runWave: async () => {
        calls += 1
        return ok()
      },
      checkpoint: async () => {
        throw new Error("checkpoint down")
      },
    })
    // The checkpoint throw does not abort the run; remaining tasks still run.
    expect(res.status).toBe("succeeded")
    expect(calls).toBe(2)
  })

  it("does not satisfy downstream dependencies with a failed wave under errorPolicy=continue", async () => {
    let calls = 0
    const res = await runTeamWaves({
      teamCtx: makeCtx(),
      tasks: [task("t1"), task("t2", ["t1"])],
      initialConcurrency: 1,
      errorPolicy: "continue",
      signal: new AbortController().signal,
      runWave: async () => {
        calls += 1
        return calls === 1 ? { runId: "run1", status: "failed" } : ok()
      },
      checkpoint: async ({ remaining }) => ({
        remaining,
        finish: false,
        decision: {
          action: "continue" as const,
          reasoning: "x",
          newTasks: [],
          cancelTaskIds: [],
          reorderTaskIds: [],
          newMembers: [],
        },
      }),
    })
    expect(res.status).toBe("failed")
    expect(res.waves).toBe(1)
    expect(calls).toBe(1)
  })
})
