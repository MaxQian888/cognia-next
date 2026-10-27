import type { EvalCase, EvalSample } from "@/types/eval/eval"
import {
  createPureModelEvalTarget,
  type PureModelEvalTargetConfig,
  type PureModelEvalTargetDeps,
} from "./targets/model"
import { runIsolatedTeamEval } from "./team-execution"
import {
  runResearchTrial,
  summarizeResearchTrials,
  type ResearchTrialInput,
} from "./multiagentbench-runtime"
import { parseResearchTasks, parseResearchRubrics } from "./multiagentbench"
import sourceTask from "@/test-fixtures/eval/multiagentbench/research-1.json"
import sourceRubrics from "@/test-fixtures/eval/multiagentbench/evaluator-prompts.json"

function sample(output: string): EvalSample {
  return {
    output,
    toolCalls: [],
    retrievedChunks: [],
    usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 },
    costUsd: 0,
    latencyMs: 10,
    stepCount: 1,
    degraded: false,
    executionStatus: "completed",
    metricAvailability: { usage: "known", cost: "unavailable", latency: "known" },
  }
}
function input(): ResearchTrialInput {
  return {
    task: parseResearchTasks(JSON.stringify(sourceTask))[0]!,
    rubrics: parseResearchRubrics(JSON.stringify(sourceRubrics)),
    variant: "single-agent",
    repetition: 1,
    providerId: "openai",
    modelId: "solver",
    judgeModelId: "judge",
    settings: null,
    timeoutMs: 120_000,
    tokenBudget: 131_072,
    judgeTokenBudget: 131_072,
  }
}
const ratings = JSON.stringify({
  ratings: { innovation: 4, safety: 5, feasibility: 3 },
  evidence: Object.fromEntries(
    ["innovation", "safety", "feasibility"].map((kind) => [
      kind,
      { reason: "Criterion-specific fixture assessment", quote: "proposal" },
    ])
  ),
})
function targets(answer = ratings) {
  return jest.fn((config: PureModelEvalTargetConfig) => ({
    label: config.label,
    run: jest.fn(async (evalCase: EvalCase) => {
      config.onPreparedTextParts?.(
        (evalCase.contentParts ?? []).flatMap((part) => (part.type === "text" ? [part.text] : []))
      )
      return sample(
        config.label.endsWith("research")
          ? answer
          : config.label.endsWith("milestones")
            ? "[]"
            : config.label.endsWith("communication")
              ? '{"rating":4}'
              : "Final research proposal"
      )
    }),
  }))
}

it("separates solver and judge consumption and keeps the actual source research rubric", async () => {
  const createTarget = targets()
  const trial = await runResearchTrial(input(), { createTarget })
  expect(trial.solver.status).toBe("completed")
  expect(createTarget.mock.calls[0][0]).toEqual(
    expect.objectContaining({
      parameters: { temperature: 0, maxOutputTokens: 8192 },
      reasoningEffort: "low",
    })
  )
  expect(trial.judgments.find((row) => row.kind === "research")?.ratings).toEqual({
    innovation: 4,
    safety: 5,
    feasibility: 3,
  })
  expect(trial.judgments.find((row) => row.kind === "communication")?.status).toBe("not_applicable")
  const summary = summarizeResearchTrials([trial])[0]!
  expect(summary.attemptedTrials).toBe(1)
  expect(summary.gradedTrials).toBe(1)
  expect(summary.meanResearchRating).toBe(4)
  expect(summary.solverTokens.total).toBe(12)
  expect(summary.judgeTokens.total).toBe(24)
  expect(summary.currencyCost).toBeNull()
  const researchTarget = createTarget.mock.results.find((row, index) =>
    createTarget.mock.calls[index][0].label.endsWith("research")
  )!.value
  expect(researchTarget.run.mock.calls[0][0].input).toContain("Innovation (1-5)")
  expect(researchTarget.run.mock.calls[0][0].input).not.toContain("single-agent")
})

it.each(["solver", "judge"] as const)(
  "does not dispatch %s after its durable admission fails",
  async (phase) => {
    const createTarget = targets()
    const trial = await runResearchTrial(
      {
        ...input(),
        onCall: async (event) => {
          if (event.state === "admitted" && event.phase === phase) throw Error("evidence disk full")
        },
      },
      { createTarget }
    )
    const runs = createTarget.mock.results.map((row) => row.value.run.mock.calls.length)
    expect(runs[0]).toBe(phase === "solver" ? 0 : 1)
    if (phase === "solver") expect(trial.solver.status).toBe("failed")
    else {
      expect(runs[1]).toBe(0)
      expect(trial.judgments.find((row) => row.kind === "research")?.attempted).toBe(false)
    }
  }
)

it("skips optional diagnostics by declared policy and keeps structural acceptance separate", async () => {
  const createTarget = targets()
  const trial = await runResearchTrial({ ...input(), diagnostics: false }, { createTarget })
  expect(createTarget).toHaveBeenCalledTimes(2)
  expect(trial.solver.status).toBe("completed")
  expect(trial.acceptance?.passed).toBe(false)
  expect(trial.judgments.find((row) => row.kind === "milestones")).toMatchObject({
    status: "skipped",
    attempted: false,
  })
  expect(summarizeResearchTrials([trial])[0]).toMatchObject({
    completedTrials: 1,
    structurallyValidTrials: 0,
    gradedTrials: 1,
  })
})

it("reports source records and introduction clusters as different sampling units", async () => {
  const task = input().task
  const first = await runResearchTrial(input(), { createTarget: targets() })
  const second = { ...first, taskId: "repeated-introduction" }
  const summary = summarizeResearchTrials(
    [first, second],
    [task, { ...task, taskId: second.taskId }]
  )[0]
  expect(summary).toMatchObject({
    uniqueTasks: 2,
    uniqueIntroductions: 1,
    gradedIntroductionClusters: 1,
    meanRatingPerIntroduction: 4,
  })
})

it("records delivered dependency payloads without claiming that the model used them", async () => {
  const createTarget = targets()
  const trial = await runResearchTrial(
    { ...input(), variant: "parallel-squad" },
    {
      createTarget,
      runTeam: (args, deps) =>
        runIsolatedTeamEval(args, {
          ...deps,
          runMember: async () => sample("A short proposal contribution"),
        }),
    }
  )
  const communicationIndex = createTarget.mock.calls.findIndex(([config]) =>
    config.label.endsWith("communication")
  )
  const prompt = createTarget.mock.results[communicationIndex].value.run.mock.calls[0][0].input
  expect(prompt).toContain('"allowedAgentIds"')
  expect(prompt).toContain('"taskId":"final-proposal"')
  expect(prompt).toContain('"dependencies":[')
  expect(prompt).toContain("does not prove information uptake")
  expect(trial.judgments.find((row) => row.kind === "communication")?.evidenceBasis).toBe(
    "dependency-payload-text-proxy"
  )
})

it("retains billed malformed judgments as ungraded rather than a neutral score", async () => {
  const trial = await runResearchTrial(input(), { createTarget: targets("unreadable rating 3") })
  const judgment = trial.judgments.find((row) => row.kind === "research")!
  expect(judgment.status).toBe("error")
  expect(judgment.sample?.usage.inputTokens).toBe(10)
  const summary = summarizeResearchTrials([trial])[0]!
  expect(summary.gradedTrials).toBe(0)
  expect(summary.meanResearchRating).toBeNull()
  expect(summary.judgeTokens.total).toBe(24)
})

it("allows an independent longer judge deadline and output budget without changing the solver", async () => {
  const timeout = jest.spyOn(AbortSignal, "timeout")
  const createTarget = targets()
  try {
    const trial = await runResearchTrial(
      { ...input(), ...{ judgeTimeoutMs: 180_000 }, maxJudgeOutputTokens: 8192 },
      { createTarget }
    )
    expect(trial.judgments.find((row) => row.kind === "research")?.status).toBe("graded")
    expect(timeout.mock.calls.map(([duration]) => duration)).toEqual([120_000, 180_000, 180_000])
    expect(createTarget.mock.calls[0][0]).toEqual(
      expect.objectContaining({ parameters: { temperature: 0, maxOutputTokens: 8192 } })
    )
    expect(createTarget.mock.calls[1][0]).toEqual(
      expect.objectContaining({ parameters: { temperature: 0, maxOutputTokens: 8192 } })
    )
  } finally {
    timeout.mockRestore()
  }
})

it("keeps solver errors in the attempted denominator and never grades them", async () => {
  const createTarget = jest.fn(() => ({
    label: "failed",
    run: jest.fn(async () => {
      throw Error("provider failed")
    }),
  }))
  const failed = await runResearchTrial(input(), { createTarget })
  const good = await runResearchTrial({ ...input(), repetition: 2 }, { createTarget: targets() })
  expect(createTarget).toHaveBeenCalledTimes(1)
  expect(
    failed.judgments.every((row) => row.status === "skipped" || row.status === "not_applicable")
  ).toBe(true)
  const summary = summarizeResearchTrials([failed, good])[0]!
  expect(summary.attemptedTrials).toBe(2)
  expect(summary.completedTrials).toBe(1)
  expect(summary.gradedTrials).toBe(1)
  expect(summary.solverTokens.unmeasuredAttempts).toBe(1)
  expect(summary.solverTokens.totalsAreLowerBounds).toBe(true)
})

it("never grades a populated solver error even when its terminal status says completed", async () => {
  const createTarget = jest.fn(() => ({
    label: "failed",
    run: jest.fn(async () => ({
      ...sample("A plausible proposal"),
      error: "provider settlement failed",
    })),
  }))
  const trial = await runResearchTrial(input(), { createTarget })
  expect(trial.solver.status).toBe("failed")
  expect(createTarget).toHaveBeenCalledTimes(1)
})

it("retains partial Squad spans and contributions after a later failure", async () => {
  const runTeam = jest.fn(async (args) => {
    args.onMemberResult({ agentId: "agent1", taskId: "contribution-agent1", output: "partial" })
    return {
      runId: "partial",
      traceId: "trace",
      status: "failed" as const,
      reason: "later failure",
      output: "partial",
      wallTimeMs: 100,
      costKnown: false,
      executionProfile: "isolated-text" as const,
      spans: [
        {
          id: "call",
          spanId: "call",
          traceId: "trace",
          operationName: "chat" as const,
          providerName: "test",
          sessionId: "session",
          surface: "agent-team" as const,
          startTime: 0,
          endTime: 10,
          usage: sample("").usage,
          metadata: { usageKnown: false, costKnown: false },
        },
      ],
    }
  })
  const trial = await runResearchTrial(
    { ...input(), variant: "parallel-squad" },
    { runTeam, createTarget: targets() }
  )
  expect(trial.solver.status).toBe("failed")
  expect(trial.solver.contributions[0].output).toBe("partial")
  expect(trial.solver.sample?.usage.inputTokens).toBe(10)
  expect(
    summarizeResearchTrials([trial]).find((row) => row.variant === "parallel-squad")!.solverTokens
      .partialAttempts
  ).toBe(1)
})

it.each(["partial", "unavailable", "throw"] as const)(
  "refuses further judge admission after %s accounting",
  async (mode) => {
    const createTarget = jest.fn((config: { label: string }) => ({
      label: config.label,
      run: jest.fn(async () => {
        if (config.label.endsWith("research")) {
          if (mode === "throw") throw Error("request lost after admission")
          return {
            ...sample(ratings),
            metricAvailability: {
              usage: mode,
              cost: "unavailable" as const,
              latency: "known" as const,
            },
          }
        }
        return sample("proposal")
      }),
    }))
    const trial = await runResearchTrial(input(), { createTarget })
    expect(createTarget).toHaveBeenCalledTimes(2)
    expect(trial.judgments.find((row) => row.kind === "milestones")?.status).toBe("skipped")
    const usage = summarizeResearchTrials([trial])[0]!.judgeTokens
    expect(usage.totalsAreLowerBounds).toBe(true)
    expect(usage.partialAttempts).toBe(mode === "partial" ? 1 : 0)
    expect(usage.unmeasuredAttempts).toBe(mode === "partial" ? 0 : 1)
    expect(usage.total).toBe(mode === "partial" ? 12 : 0)
  }
)

it("stops judge admission after cancellation and preserves the first settled usage", async () => {
  const controller = new AbortController()
  const createTarget = jest.fn((config: PureModelEvalTargetConfig) => ({
    label: config.label,
    run: jest.fn(async (evalCase: EvalCase) => {
      config.onPreparedTextParts?.(
        (evalCase.contentParts ?? []).flatMap((part) => (part.type === "text" ? [part.text] : []))
      )
      if (config.label.endsWith("research")) controller.abort()
      return sample(config.label.endsWith("research") ? ratings : "proposal")
    }),
  }))
  const trial = await runResearchTrial({ ...input(), signal: controller.signal }, { createTarget })
  expect(createTarget).toHaveBeenCalledTimes(2)
  expect(trial.judgments.find((row) => row.kind === "research")?.status).toBe("graded")
  expect(trial.judgments.find((row) => row.kind === "milestones")?.status).toBe("skipped")
  expect(summarizeResearchTrials([trial])[0]!.judgeTokens.total).toBe(12)
})

it.each(["solver", "judge"] as const)(
  "retains the known %s response when settlement persistence rejects",
  async (phase) => {
    const trial = await runResearchTrial(
      {
        ...input(),
        onCall: async (event) => {
          if (event.phase === phase && event.state === "settled")
            throw Error("settlement disk failure")
        },
      },
      { createTarget: targets() }
    )
    const retained = phase === "solver" ? trial.solver.sample : trial.judgments[0].sample
    expect(retained?.usage).toMatchObject({ inputTokens: 10, outputTokens: 2 })
    expect(phase === "solver" ? trial.solver.status : trial.judgments[0].status).not.toBe("graded")
    expect(trial.judgments.filter((j) => j.attempted)).toHaveLength(phase === "solver" ? 0 : 1)
  }
)

it("aborts already waiting Squad admissions when a different evidence barrier fails without caller abort", async () => {
  const options = input()
  options.task.agents = options.task.agents.slice(0, 2)
  let entered = 0
  let release!: () => void
  const secondEntered = new Promise<void>((resolve) => {
    release = resolve
  })
  const runMember = jest.fn(async () => sample("proposal"))
  const trial = await runResearchTrial(
    {
      ...options,
      variant: "parallel-squad",
      onCall: async (event) => {
        if (event.state !== "admitted") return
        if (++entered === 1) {
          await secondEntered
          throw Error("first admission failed")
        }
        release()
        await new Promise((resolve) => setTimeout(resolve, 1))
      },
    },
    {
      createTarget: targets(),
      runTeam: (args, deps) => runIsolatedTeamEval(args, { ...deps, runMember }),
    }
  )
  expect(entered).toBe(2)
  expect(runMember).not.toHaveBeenCalled()
  expect(trial.solver.status).not.toBe("completed")
})

it("checks research quotes against the exact PII-gated proposal supplied to the judge", async () => {
  const options = input()
  options.rubrics.research = "Contact bob@example.com. Proposal: {result}"
  let proposalSeen = ""
  const trial = await runResearchTrial(options, {
    createTarget: (config) =>
      createPureModelEvalTarget(config, {
        createSnapshot: (() => ({})) as never,
        resolveProvider: (() => ({
          kind: "resolved",
          providerId: "openai",
          protocol: "openai",
          model: "fixture",
          baseURL: "http://127.0.0.1:8787/v1",
        })) as never,
        createModel: (() => ({})) as never,
        generateText: (async (args: Parameters<PureModelEvalTargetDeps["generateText"]>[0]) => {
          const isJudge = config.label.startsWith("mab-judge")
          if (!isJudge)
            return {
              text: "Contact alice@example.com for this proposal.",
              usage: { inputTokens: 10, outputTokens: 2 },
              finishReason: "stop",
            }
          const content = args.messages![0].content as Array<{ text: string }>
          if (config.label.endsWith("research")) {
            proposalSeen = content[1].text
            expect(proposalSeen).not.toContain("alice@example.com")
            expect(content[0].text).not.toContain("bob@example.com")
            return {
              text: JSON.stringify({
                ratings: { innovation: 3, safety: 3, feasibility: 3 },
                evidence: Object.fromEntries(
                  ["innovation", "safety", "feasibility"].map((k) => [
                    k,
                    { reason: "Quoted from visible payload", quote: proposalSeen },
                  ])
                ),
              }),
              usage: { inputTokens: 10, outputTokens: 2 },
              finishReason: "stop",
            }
          }
          return { text: "[]", usage: { inputTokens: 10, outputTokens: 2 }, finishReason: "stop" }
        }) as never,
        now: () => 1,
      }),
  })
  expect(trial.judgments[0]).toMatchObject({ status: "graded", visibleProposal: proposalSeen })
  expect(proposalSeen).toContain("<EMAIL_002>")
})

it("gives communication and milestone judges only their own output schema", async () => {
  const createTarget = targets()
  await runResearchTrial(
    { ...input(), variant: "parallel-squad" },
    {
      createTarget,
      runTeam: (args, deps) =>
        runIsolatedTeamEval(args, { ...deps, runMember: async () => sample("proposal") }),
    }
  )
  const prompts = Object.fromEntries(
    createTarget.mock.calls.map(([config], i) => [
      config.label,
      createTarget.mock.results[i].value.run.mock.calls[0][0].input,
    ])
  )
  expect(prompts["mab-judge:communication"]).not.toContain("milestoneOutputSchema")
  expect(prompts["mab-judge:communication"]).toContain('"required":["rating"]')
  expect(prompts["mab-judge:milestones"]).toContain('"required":["milestone","agents"]')
  expect(prompts["mab-judge:milestones"]).not.toContain('"required":["rating"]')
})

it("refuses a judge budget below the admission envelope before making a judge call", async () => {
  const createTarget = targets()
  const trial = await runResearchTrial({ ...input(), judgeTokenBudget: 1 }, { createTarget })
  expect(createTarget).toHaveBeenCalledTimes(1)
  expect(trial.judgments.find((row) => row.kind === "research")?.error).toMatch(/budget/)
  expect(summarizeResearchTrials([trial])[0]!.judgeTokens.total).toBe(0)
})

it("marks communication inapplicable for a public task with only one researcher", async () => {
  const options = input()
  options.task.agents = options.task.agents.slice(0, 1)
  const trial = await runResearchTrial(
    { ...options, variant: "parallel-squad" },
    {
      createTarget: targets(),
      runTeam: (args, deps) =>
        runIsolatedTeamEval(args, { ...deps, runMember: async () => sample("proposal") }),
    }
  )
  expect(trial.solver.status).toBe("completed")
  expect(trial.judgments.find((row) => row.kind === "communication")?.status).toBe("not_applicable")
  expect(trial.solver.contributions).toHaveLength(2)
})

it.each(["serial-squad", "parallel-squad"] as const)(
  "executes %s through real private admission and DAG scheduling",
  async (variant) => {
    let active = 0
    let peak = 0
    const task = input().task
    const trial = await runResearchTrial(
      { ...input(), variant },
      {
        createTarget: targets(),
        runTeam: (args, deps) =>
          runIsolatedTeamEval(args, {
            ...deps,
            runMember: async () => {
              peak = Math.max(peak, ++active)
              await new Promise((resolve) => setTimeout(resolve, 2))
              active--
              return sample("A contribution to the proposal")
            },
          }),
      }
    )
    expect(trial.solver.status).toBe("completed")
    expect(trial.solver.contributions).toHaveLength(task.agents.length + 1)
    expect(trial.solver.sample?.usage.inputTokens).toBe(10 * (task.agents.length + 1))
    expect(peak).toBe(variant === "serial-squad" ? 1 : task.agents.length)
  }
)
