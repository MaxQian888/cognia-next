/** @jest-environment jsdom */

jest.mock("@/stores/agent/external-agent-store", () => ({
  useExternalAgentStore: {
    getState: () => ({ agents: { cfg: { id: "cfg", metadata: { preset: "codex-app-server" } } } }),
  },
}))

import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import type { SessionUsageRow } from "@/lib/db/session-usage"
import { externalAgentProviderId } from "@/lib/ai/agent/external/session/session-models"
import type { BestOfNRunSummary } from "@/types/best-of-n"
import type { ExecutionRun } from "@/types/execution/run"
import type { Goal } from "@/types/goal"

import { ESTIMATE_WINDOW_MS } from "./estimate"
import {
  __resetRunSampleCacheForTesting,
  loadRunEstimateContext,
  SAMPLE_CACHE_TTL_MS,
} from "./load-samples"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

const NOW = Date.UTC(2026, 9, 1)

function usage(over: Partial<SessionUsageRow>): SessionUsageRow {
  return {
    messageId: `m-${Math.random()}`,
    sessionId: "s",
    at: NOW - 60_000,
    inputTokens: 100,
    outputTokens: 10,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
    durationMs: 0,
    ...over,
  }
}

async function seed() {
  const db = getDb()
  await db.sessionUsage.bulkPut([
    usage({ sessionId: "goal:g1" }),
    usage({ sessionId: "team:r1", model: "claude-opus-4-1" }),
    usage({ sessionId: "sched1", surface: "chat", model: "gpt-5", providerId: "openai" }),
    usage({ sessionId: "plain", surface: "chat" }),
    usage({ sessionId: "goal:old", at: NOW - ESTIMATE_WINDOW_MS - 1 }),
  ])
  await db.chatGoals.put({
    id: "g1",
    sessionId: "chat1",
    rawObjective: "x",
    safeObjective: "x",
    redactionMapEnc: "",
    status: "completed",
    turnsUsed: 1,
    tokensUsed: 0,
    judgeFailureCount: 0,
    config: { maxTurns: 1, maxTokens: 1, maxJudgeFailures: 1, timeoutMs: 1 },
    generationId: "g",
    createdAt: NOW - 120_000,
    updatedAt: NOW - 30_000,
    endedAt: NOW - 30_000,
  } as Goal)
  await db.executionRuns.put({
    id: "execution:team:r1",
    kind: "team",
    sourceId: "r1",
    title: "Squad",
    status: "completed",
    currentRevision: 1,
    startedAt: NOW - 300_000,
    updatedAt: NOW - 1000,
    endedAt: NOW - 1000,
  } as ExecutionRun)
  await db.bestOfNRuns.put({
    id: "b1",
    updatedAt: NOW - 1000,
    group: {
      candidates: [
        {
          candidateId: "c1",
          agent: { agentId: "char", provider: externalAgentProviderId("cfg") },
          status: "succeeded",
          costUsd: 2,
          startedAt: NOW - 50_000,
          finishedAt: NOW - 10_000,
        },
      ],
    },
  } as unknown as BestOfNRunSummary)
  await db.sessions.bulkPut([
    {
      id: "sched1",
      title: "t",
      createdAt: new Date(NOW),
      updatedAt: new Date(NOW),
      origin: { kind: "scheduled-task", taskId: "task", taskName: "Nightly" },
    },
    { id: "plain", title: "t", createdAt: new Date(NOW), updatedAt: new Date(NOW) },
  ] as never)
}

beforeEach(() => {
  __resetRunSampleCacheForTesting()
})

describe("loadRunEstimateContext", () => {
  it("reads every surface's history inside the window", async () => {
    await seed()
    const { samples } = await loadRunEstimateContext({ now: NOW })
    const bySurface = Object.fromEntries(samples.map((s) => [s.surface, s]))
    expect(Object.keys(bySurface).sort()).toEqual(["best-of-n", "goal", "scheduled", "team"])
    expect(bySurface["best-of-n"].harness).toBe("ext:codex")
    expect(bySurface.team.modelFamily).toBe("claude-opus")
    expect(bySurface.scheduled.modelFamily).toBe("gpt")
  })

  it("caches within the TTL and rereads after it", async () => {
    const first = await loadRunEstimateContext({ now: NOW })
    expect(first.samples).toHaveLength(0)
    await seed()
    const cached = await loadRunEstimateContext({ now: NOW + 1000 })
    expect(cached.samples).toHaveLength(0)
    const fresh = await loadRunEstimateContext({ now: NOW + SAMPLE_CACHE_TTL_MS })
    expect(fresh.samples.length).toBeGreaterThan(0)
  })

  it("shares one read between concurrent callers", async () => {
    await seed()
    const [a, b] = await Promise.all([
      loadRunEstimateContext({ now: NOW }),
      loadRunEstimateContext({ now: NOW }),
    ])
    expect(a).toBe(b)
  })

  it("uses an injected preset resolver", async () => {
    await seed()
    const { samples, resolvePreset } = await loadRunEstimateContext({
      now: NOW,
      resolvePreset: () => "pi-rpc",
    })
    expect(samples.find((s) => s.surface === "best-of-n")?.harness).toBe("ext:pi")
    expect(resolvePreset("anything")).toBe("pi-rpc")
  })
})
