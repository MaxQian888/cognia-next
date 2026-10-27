import { runIsolatedTeamEval, type TeamEvalDefinition } from "./team-execution"
import { DEFAULT_TEAM_CONFIG } from "@/types/agent/agent-team"
import type { EvalSample } from "@/types/eval/eval"

function definition(): TeamEvalDefinition {
  return {
    team: {
      id: "source",
      name: "Source",
      leadId: "lead",
      task: "original",
      config: {
        ...structuredClone(DEFAULT_TEAM_CONFIG),
        riskGating: false,
        maxConcurrentTeammates: 2,
      },
    } as TeamEvalDefinition["team"],
    members: ["one", "two"].map((id) => ({
      id,
      teamId: "source",
      name: id,
      description: "solver",
      role: "teammate",
      config: {},
    })) as TeamEvalDefinition["members"],
    tasks: ["a", "b"].map((id) => ({
      id,
      teamId: "source",
      title: id,
      description: "solve " + id,
      dependencies: [],
      status: "pending",
      priority: "normal",
      tags: [],
      createdAt: new Date(),
      order: 0,
    })) as TeamEvalDefinition["tasks"],
    settings: null,
  }
}
const result = (text: string): EvalSample => ({
  output: text,
  toolCalls: [],
  retrievedChunks: [],
  usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 },
  costUsd: 0.01,
  latencyMs: 1,
  stepCount: 1,
  degraded: false,
  metricAvailability: { usage: "known", cost: "estimated", latency: "known" },
})

it("persists member admission before dispatch and never dispatches after a failed barrier", async () => {
  const calls: string[] = []
  const runMember = jest.fn(async () => {
    calls.push("dispatch")
    return result("answer")
  })
  const source = definition()
  source.tasks = source.tasks.slice(0, 1)
  const run = await runIsolatedTeamEval(
    {
      teamId: "source",
      prompt: "objective",
      traceId: "durable",
      onCall: async (event) => {
        calls.push(event.state)
        if (event.state === "admitted") throw Error("disk full before dispatch")
      },
    },
    { loadDefinition: async () => source, runMember }
  )
  expect(run.status).toBe("failed")
  expect(runMember).not.toHaveBeenCalled()
  expect(calls).toEqual(["admitted"])
})

it("applies the same durable admission barrier to final synthesis and releases workers", async () => {
  const source = definition()
  source.tasks.push({
    ...source.tasks[0],
    id: "final-proposal",
    dependencies: ["a", "b"],
    order: 2,
  })
  const runMember = jest.fn(async () => result("known billed output"))
  const settled: string[] = []
  const run = await runIsolatedTeamEval(
    {
      teamId: "source",
      prompt: "objective",
      traceId: "final-barrier",
      onCall: async (event) => {
        if (event.state === "admitted" && event.taskId === "final-proposal")
          throw Error("cannot persist final admission")
        if (event.state === "settled") settled.push(event.callId)
      },
    },
    { loadDefinition: async () => source, runMember }
  )
  expect(run.status).toBe("failed")
  expect(runMember).toHaveBeenCalledTimes(2)
  expect(run.spans).toHaveLength(2)
  expect(new Set(settled).size).toBe(2)
  const next = await runIsolatedTeamEval(
    { teamId: "source", prompt: "next", traceId: "next-clean-run" },
    {
      loadDefinition: async () => source,
      runMember: async () => result("next output"),
    }
  )
  expect(next.status).toBe("completed")
})

it("awaits already-dispatched parallel work and refuses new admission after persistence aborts", async () => {
  const source = definition()
  const controller = new AbortController()
  let admissions = 0
  const runMember = jest.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5))
    return result("response arrived during abort")
  })
  const run = await runIsolatedTeamEval(
    {
      teamId: "source",
      prompt: "objective",
      traceId: "parallel-fault",
      signal: controller.signal,
      onCall: async (event) => {
        if (event.state === "admitted" && ++admissions === 2) {
          controller.abort(Error("journal failure"))
          throw Error("journal failure")
        }
      },
    },
    { loadDefinition: async () => source, runMember }
  )
  expect(run.status).toBe("cancelled")
  expect(runMember).toHaveBeenCalledTimes(1)
  expect(run.spans).toHaveLength(1)
  expect(run.spans[0].usage?.inputTokens).toBe(10)
})

it("runs the production admission/coordinator/waves against private snapshots and captures every member", async () => {
  const source = definition()
  const before = JSON.stringify(source)
  const contributions: Array<{ agentId: string; taskId: string; output: string }> = []
  let active = 0
  let peak = 0
  const run = await runIsolatedTeamEval(
    {
      teamId: "source",
      prompt: "case objective",
      traceId: "trace-test",
      maxOutputTokens: 8192,
      onMemberResult: (entry) => contributions.push(entry),
    },
    {
      loadDefinition: async () => source,
      runMember: async ({ prompt, signal, maxOutputTokens }) => {
        expect(prompt).toContain("case objective")
        expect(signal.aborted).toBe(false)
        expect(maxOutputTokens).toBe(8192)
        peak = Math.max(peak, ++active)
        await new Promise((resolve) => setTimeout(resolve, 5))
        active -= 1
        return result("answer")
      },
    }
  )
  expect(run.status).toBe("completed")
  expect(run.executionProfile).toBe("isolated-text")
  expect(run.spans.filter((span) => span.metadata?.accountingScope === "call")).toHaveLength(2)
  expect(peak).toBe(2)
  expect(contributions.map((entry) => entry.taskId).sort()).toEqual(["a", "b"])
  expect(contributions.every((entry) => entry.output === "answer")).toBe(true)
  expect(JSON.stringify(source)).toBe(before)
})

it("retains usage and fails a text member with no visible output", async () => {
  const run = await runIsolatedTeamEval(
    { teamId: "source", prompt: "goal", traceId: "empty" },
    { loadDefinition: async () => definition(), runMember: async () => result("") }
  )
  expect(run.status).toBe("failed")
  expect(run.reason).toContain("empty_output")
  expect(run.spans[0]?.usage?.inputTokens).toBe(10)
})

it("serializes members at concurrency one and carries dependencies through private memory", async () => {
  const source = definition()
  source.team.config.maxConcurrentTeammates = 1
  source.tasks[1]!.dependencies = ["a"]
  const prompts: string[] = []
  const run = await runIsolatedTeamEval(
    { teamId: "source", prompt: "goal", traceId: "trace-test" },
    {
      loadDefinition: async () => source,
      runMember: async ({ prompt }) => {
        prompts.push(prompt)
        return result("upstream answer")
      },
    }
  )
  expect(run.status).toBe("completed")
  expect(prompts).toHaveLength(2)
  expect(prompts[1]).toContain("upstream answer")
})

it("refuses non-isolated capabilities before any model request", async () => {
  const source = definition()
  source.members[0]!.config.runtime = "codex"
  const runMember = jest.fn(async () => result("never"))
  const run = await runIsolatedTeamEval(
    { teamId: "source", prompt: "goal", traceId: "trace-test" },
    { loadDefinition: async () => source, runMember }
  )
  expect(run.status).toBe("blocked")
  expect(run.reason).toMatch(/unsupported/)
  expect(runMember).not.toHaveBeenCalled()
})

it("requires rates before claiming a monetary cap and refuses a call exceeding its allocation", async () => {
  const runMember = jest.fn(async () => result("never"))
  const deps = { loadDefinition: async () => definition(), runMember }
  const noRates = await runIsolatedTeamEval(
    { teamId: "source", prompt: "goal", traceId: "t", maxCostUsd: 1 },
    deps
  )
  expect(noRates.status).toBe("blocked")
  const tooSmall = await runIsolatedTeamEval(
    {
      teamId: "source",
      prompt: "goal",
      traceId: "t",
      maxCostUsd: 0.000001,
      price: { inputPerMillion: 10, outputPerMillion: 10, currency: "USD" },
    },
    deps
  )
  expect(tooSmall.status).toBe("failed")
  expect(runMember).not.toHaveBeenCalled()
})

it("keeps exact-worker assignments pinned even when both independent tasks prefer one member", async () => {
  const source = definition()
  for (const task of source.tasks) task.assignedTo = "one"
  const used: string[] = []
  const run = await runIsolatedTeamEval(
    { teamId: "source", prompt: "goal", traceId: "pinned" },
    {
      loadDefinition: async () => source,
      runMember: async ({ member }) => {
        used.push(member.id)
        await new Promise((resolve) => setTimeout(resolve, 2))
        return result("answer")
      },
    }
  )
  expect(run.status).toBe("completed")
  expect(used).toEqual(["one", "one"])
})

it("refuses native workspace profiles rather than substituting text execution", async () => {
  const source = definition()
  source.team.config.workingDir = "/user/project"
  const runMember = jest.fn(async () => result("never"))
  const run = await runIsolatedTeamEval(
    { teamId: "source", prompt: "goal", traceId: "blocked" },
    { loadDefinition: async () => source, runMember }
  )
  expect(run.status).toBe("blocked")
  expect(runMember).not.toHaveBeenCalled()
})

it("retains settled spans and stops spending after priced accounting becomes unavailable", async () => {
  const source = definition()
  source.team.config.maxConcurrentTeammates = 1
  let calls = 0
  const captured: unknown[] = []
  const run = await runIsolatedTeamEval(
    {
      teamId: "source",
      prompt: "goal",
      traceId: "unknown",
      maxCostUsd: 1,
      price: { inputPerMillion: 1, outputPerMillion: 1, currency: "USD" },
      onSpan: (span) => captured.push(span),
    },
    {
      loadDefinition: async () => source,
      runMember: async () => {
        calls += 1
        return {
          ...result("answer"),
          metricAvailability: { usage: "partial", cost: "unavailable", latency: "known" },
        }
      },
    }
  )
  expect(run.status).toBe("failed")
  expect(calls).toBe(1)
  expect(captured).toHaveLength(1)
  expect(run.costKnown).toBe(false)
})

it.each(["cancel", "timeout"])(
  "retains the first settled member's accounting through host %s",
  async (kind) => {
    const source = definition()
    source.team.config.maxConcurrentTeammates = 1
    source.tasks[1]!.dependencies = ["a"]
    const controller = new AbortController()
    let calls = 0
    const captured: Array<{ costUsdEstimate?: number }> = []
    const contributions: Array<{ taskId: string; output: string }> = []
    const run = await runIsolatedTeamEval(
      {
        teamId: "source",
        prompt: "goal",
        traceId: "interrupted",
        signal: controller.signal,
        timeoutMs: kind === "timeout" ? 100 : 2000,
        onSpan: (span) => captured.push(span),
        onMemberResult: (entry) => contributions.push(entry),
      },
      {
        loadDefinition: async () => source,
        runMember: async ({ signal }) => {
          calls += 1
          if (calls === 1) return result("first answer")
          return new Promise<EvalSample>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true })
            if (kind === "cancel") controller.abort(new DOMException("Operator stop", "AbortError"))
          })
        },
      }
    )
    expect(run.status).toBe(kind === "timeout" ? "timed_out" : "cancelled")
    expect(calls).toBe(2)
    expect(captured).toHaveLength(2)
    expect(captured[0]?.costUsdEstimate).toBe(0.01)
    expect(run.spans[0]?.usage?.inputTokens).toBe(10)
    expect(run.costKnown).toBe(false)
    expect(contributions).toEqual([
      expect.objectContaining({ taskId: "a", output: "first answer" }),
    ])
  }
)

it.each(["cost", "tokens"])(
  "reserves simultaneous calls against the shared %s ceiling before dispatch",
  async (kind) => {
    const source = definition()
    if (kind === "tokens") source.team.config.tokenBudget = 4500
    let calls = 0
    const run = await runIsolatedTeamEval(
      {
        teamId: "source",
        prompt: "goal",
        traceId: "concurrent-cap",
        ...(kind === "cost"
          ? {
              maxCostUsd: 0.008,
              price: { inputPerMillion: 1, outputPerMillion: 1, currency: "USD" },
            }
          : {}),
      },
      {
        loadDefinition: async () => source,
        runMember: async () => {
          calls += 1
          await new Promise((resolve) => setTimeout(resolve, 5))
          return { ...result("answer"), costUsd: 0.000012 }
        },
      }
    )
    expect(run.status).toBe("failed")
    expect(run.reason).toContain("budget_exhausted")
    expect(calls).toBe(1)
  }
)

it.each(["external", "tools", "execution", "plugin", "approval"])(
  "refuses the %s capability profile before model spend",
  async (kind) => {
    const source = definition()
    if (kind === "external") source.members[0]!.config.externalAgentConfigId = "saved-agent"
    if (kind === "tools") source.members[0]!.config.tools = ["read_file"]
    if (kind === "execution")
      source.members[0]!.config.execution = {} as NonNullable<
        TeamEvalDefinition["members"][number]["config"]["execution"]
      >
    if (kind === "plugin") source.team.config.capabilities = { skillIds: ["fixture-skill"] }
    if (kind === "approval") source.team.config.requirePlanApproval = true
    const runMember = jest.fn(async () => result("never"))
    const run = await runIsolatedTeamEval(
      { teamId: "source", prompt: "goal", traceId: "capability" },
      { loadDefinition: async () => source, runMember }
    )
    expect(run.status).toBe("blocked")
    expect(runMember).not.toHaveBeenCalled()
  }
)
