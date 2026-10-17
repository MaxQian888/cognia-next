import { externalAgentProviderId } from "@/lib/ai/agent/external/session/session-models"
import type { SessionUsageRow } from "@/lib/db/session-usage"
import type { AgentTeamChildRun } from "@/types/agent/agent-team-runtime"
import type { BestOfNCandidate, BestOfNRunSummary } from "@/types/best-of-n"
import type { ExecutionRun } from "@/types/execution/run"
import type { Goal } from "@/types/goal"

import { buildRunSamples, summarizeRows, type SampleSources } from "./samples"

const T0 = 1_800_000_000_000

function row(over: Partial<SessionUsageRow>): SessionUsageRow {
  return {
    messageId: `m-${Math.random()}`,
    sessionId: "s",
    at: T0,
    inputTokens: 100,
    outputTokens: 10,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
    durationMs: 0,
    ...over,
  }
}

function goal(over: Partial<Goal>): Goal {
  return {
    id: "g1",
    sessionId: "chat1",
    rawObjective: "do it",
    safeObjective: "do it",
    redactionMapEnc: "",
    status: "completed",
    turnsUsed: 3,
    tokensUsed: 0,
    judgeFailureCount: 0,
    config: { maxTurns: 20, maxTokens: 200_000, maxJudgeFailures: 3, timeoutMs: 1 },
    generationId: "gen",
    createdAt: T0,
    updatedAt: T0 + 60_000,
    endedAt: T0 + 60_000,
    ...over,
  } as Goal
}

function teamRun(over: Partial<ExecutionRun>): ExecutionRun {
  return {
    id: "execution:team:r1",
    kind: "team",
    sourceId: "r1",
    title: "Squad",
    status: "completed",
    currentRevision: 1,
    startedAt: T0,
    updatedAt: T0 + 120_000,
    endedAt: T0 + 120_000,
    ...over,
  }
}

function child(runId: string, runtime?: string): AgentTeamChildRun {
  return { id: `c-${runtime}`, runId, runtime } as AgentTeamChildRun
}

function candidate(over: Partial<BestOfNCandidate>): BestOfNCandidate {
  return {
    candidateId: "c1",
    index: 0,
    agent: { agentId: "char", model: "claude-sonnet-4-5" },
    childSessionId: "child",
    workspaceBundleId: null,
    physicalRoot: null,
    changesetId: null,
    headSha: null,
    status: "succeeded",
    hasChanges: true,
    costUsd: 1.5,
    startedAt: T0,
    finishedAt: T0 + 30_000,
    error: null,
    ...over,
  }
}

function bestOfN(candidates: BestOfNCandidate[]): BestOfNRunSummary {
  return { id: "b1", updatedAt: T0, group: { candidates } } as unknown as BestOfNRunSummary
}

function sources(over: Partial<SampleSources>): SampleSources {
  return {
    usageRows: [],
    goals: [],
    teamRuns: [],
    teamChildRuns: [],
    bestOfN: [],
    scheduledSessions: [],
    resolvePreset: (id) => (id === "cfg-codex" ? "codex-app-server" : undefined),
    ...over,
  }
}

describe("summarizeRows", () => {
  it("sums token classes, keeps the TTL split apart, and names the dominant model", () => {
    const summary = summarizeRows([
      row({ model: "a", providerId: "p1", inputTokens: 10, outputTokens: 0, at: T0 + 5 }),
      row({
        model: "b",
        providerId: "p2",
        inputTokens: 500,
        cacheCreationTokens: 40,
        cacheCreation5mTokens: 30,
        cacheCreation1hTokens: 10,
        durationMs: 7,
      }),
      row({ cacheCreationTokens: 9, cacheReadTokens: 3, at: T0 + 9 }),
    ])!
    expect(summary.tokens).toEqual({
      input: 610,
      output: 20,
      cacheRead: 3,
      cacheWrite: 9,
      cacheWrite5m: 30,
      cacheWrite1h: 10,
    })
    expect(summary.model).toBe("b")
    expect(summary.providerId).toBe("p2")
    expect(summary.firstAt).toBe(T0)
    expect(summary.lastAt).toBe(T0 + 9)
    expect(summary.reportedDurationMs).toBe(7)
  })

  it("returns null for no rows", () => {
    expect(summarizeRows([])).toBeNull()
  })
})

describe("buildRunSamples", () => {
  it("builds a goal sample from goal rows, with the model from the session's chat rows", () => {
    const samples = buildRunSamples(
      sources({
        goals: [goal({ status: "turn_limited" })],
        usageRows: [
          row({ sessionId: "goal:g1", inputTokens: 1000 }),
          row({ sessionId: "goal:g1", inputTokens: 2000 }),
          row({
            sessionId: "chat1",
            model: "claude-sonnet-4-5",
            providerId: "anthropic",
            at: T0 + 1,
          }),
          // Outside the goal's lifetime: ignored for the model.
          row({ sessionId: "chat1", model: "gpt-5", inputTokens: 99_999, at: T0 + 999_999 }),
        ],
      })
    )
    expect(samples).toHaveLength(1)
    expect(samples[0]).toMatchObject({
      surface: "goal",
      harness: "builtin",
      modelFamily: "claude-sonnet",
      durationMs: 60_000,
      stoppedEarly: true,
      endedAt: T0 + 60_000,
    })
    expect(samples[0].tokens?.input).toBe(3000)
  })

  it("leaves a headless goal's harness and family unknown", () => {
    const [s] = buildRunSamples(
      sources({ goals: [goal({})], usageRows: [row({ sessionId: "goal:g1" })] })
    )
    expect(s.harness).toBeNull()
    expect(s.modelFamily).toBeNull()
    expect(s.stoppedEarly).toBe(false)
  })

  it("skips open goals and goals with no usage", () => {
    expect(
      buildRunSamples(
        sources({
          goals: [goal({ status: "active", endedAt: undefined }), goal({ id: "g2" })],
          usageRows: [row({ sessionId: "goal:g1" })],
        })
      )
    ).toHaveLength(0)
  })

  it("builds team samples and skips best-of-N team runs and live runs", () => {
    const samples = buildRunSamples(
      sources({
        teamRuns: [
          teamRun({ status: "failed" }),
          teamRun({ id: "x", sourceId: "best-of-n:b1" }),
          teamRun({ id: "y", sourceId: "r2", status: "running", endedAt: undefined }),
        ],
        teamChildRuns: [child("r1", "claude"), child("r1", "codex")],
        usageRows: [
          row({ sessionId: "team:r1", model: "claude-opus-4-1" }),
          row({ sessionId: "team:best-of-n:b1" }),
          row({ sessionId: "team:r2" }),
        ],
      })
    )
    expect(samples).toHaveLength(1)
    expect(samples[0]).toMatchObject({
      surface: "team",
      harness: "mixed",
      modelFamily: "claude-opus",
      durationMs: 120_000,
      stoppedEarly: true,
    })
  })

  it("builds one best-of-N sample per finished candidate from its frozen cost", () => {
    const samples = buildRunSamples(
      sources({
        bestOfN: [
          bestOfN([
            candidate({}),
            candidate({
              candidateId: "c2",
              agent: { agentId: "char", provider: externalAgentProviderId("cfg-codex") },
              status: "failed",
              costUsd: null,
              startedAt: null,
            }),
            candidate({ candidateId: "c3", status: "running", finishedAt: null }),
          ]),
        ],
      })
    )
    expect(samples).toHaveLength(2)
    expect(samples[0]).toMatchObject({
      surface: "best-of-n",
      harness: "builtin",
      modelFamily: "claude-sonnet",
      tokens: null,
      frozenCostUsd: 1.5,
      durationMs: 30_000,
      stoppedEarly: false,
    })
    expect(samples[1]).toMatchObject({
      harness: "ext:codex",
      frozenCostUsd: null,
      durationMs: null,
      stoppedEarly: true,
    })
  })

  it("builds scheduled samples from task-created conversations, not goal conversations", () => {
    const samples = buildRunSamples(
      sources({
        goals: [goal({ sessionId: "sched-goal" })],
        scheduledSessions: [
          { id: "sched1", origin: { kind: "scheduled-task" } },
          { id: "sched-goal", origin: { kind: "scheduled-task" } },
          { id: "other", origin: { kind: "gateway-api" } },
        ],
        usageRows: [
          row({ sessionId: "sched1", model: "gpt-5", providerId: "openai", at: T0 }),
          row({ sessionId: "sched1", at: T0 + 45_000 }),
          row({ sessionId: "sched1", imported: true, at: T0 + 999_000 }),
          row({ sessionId: "sched-goal" }),
          row({ sessionId: "other" }),
        ],
      })
    )
    const scheduled = samples.filter((s) => s.surface === "scheduled")
    expect(scheduled).toHaveLength(1)
    expect(scheduled[0]).toMatchObject({
      harness: "builtin",
      modelFamily: "gpt",
      durationMs: 45_000,
      endedAt: T0 + 45_000,
      stoppedEarly: null,
    })
  })

  it("uses reported turn time when a scheduled run is a single instant", () => {
    const [s] = buildRunSamples(
      sources({
        scheduledSessions: [{ id: "sched1", origin: { kind: "scheduled-task" } }],
        usageRows: [row({ sessionId: "sched1", durationMs: 4_000 })],
      })
    )
    expect(s.durationMs).toBe(4_000)
  })

  it("groups imported rows per source session into external-session samples", () => {
    const samples = buildRunSamples(
      sources({
        usageRows: [
          row({ imported: true, sourceId: "codex", sourceSessionId: "a", model: "gpt-5", at: T0 }),
          row({ imported: true, sourceId: "codex", sourceSessionId: "a", at: T0 + 10_000 }),
          row({ imported: true, sourceId: "claude-code", sourceSessionId: "a", at: T0 }),
          row({ imported: true, sessionId: "no-source" }),
        ],
      })
    )
    expect(samples.map((s) => [s.surface, s.harness])).toEqual([
      ["external-session", "ext:codex"],
      ["external-session", "ext:claude-code"],
    ])
    expect(samples[0].durationMs).toBe(10_000)
  })
})
