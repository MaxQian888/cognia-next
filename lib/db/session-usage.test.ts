// Coverage for the session-usage CRUD + aggregator layer.

import {
  deleteUsageForSession,
  listUsageForSession,
  pruneSessionUsageOlderThan,
  isLocalSpend,
  recordConnectorUsage,
  recordGoalUsage,
  recordImportedUsage,
  recordSurfaceUsage,
  recordResultUsage,
  recordTeamUsage,
  recordWorkflowStepUsage,
  swallowUsageWrite,
  topByCost,
  totalsByAllSessions,
  totalsBySession,
  upsertSessionUsage,
  type SessionUsageRow,
} from "./session-usage"
import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"
import type { SDKResultMessage } from "@cognia/agent-config-types"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await getDb().sessionUsage.clear()
})
afterAll(dbFixture.dispose)

function row(
  id: string,
  sessionId: string,
  partial: Partial<SessionUsageRow> = {}
): SessionUsageRow {
  return {
    messageId: id,
    sessionId,
    at: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
    durationMs: 0,
    ...partial,
  }
}

describe("upsertSessionUsage", () => {
  it("writes a row and round-trips", async () => {
    await upsertSessionUsage(row("m1", "s1", { inputTokens: 100, costUsd: 0.01 }))
    const list = await listUsageForSession("s1")
    expect(list).toHaveLength(1)
    expect(list[0].inputTokens).toBe(100)
    expect(list[0].costUsd).toBe(0.01)
  })

  it("is idempotent on messageId — second put overwrites in place", async () => {
    await upsertSessionUsage(row("m1", "s1", { inputTokens: 100 }))
    await upsertSessionUsage(row("m1", "s1", { inputTokens: 999 }))
    const list = await listUsageForSession("s1")
    expect(list).toHaveLength(1)
    expect(list[0].inputTokens).toBe(999)
  })

  it("ignores rows with empty messageId or sessionId", async () => {
    await upsertSessionUsage(row("", "s1"))
    await upsertSessionUsage(row("m1", ""))
    const all = await getDb().sessionUsage.toArray()
    expect(all).toHaveLength(0)
  })
})

describe("recordWorkflowStepUsage", () => {
  it("shadow-writes a workflow row with synthetic id + surface", async () => {
    const written = await recordWorkflowStepUsage({
      runId: "run1",
      stepId: "n1",
      usage: {
        inputTokens: 100,
        outputTokens: 40,
        cacheReadTokens: 60,
        costUsd: 0.02,
        model: "gpt-4o",
        providerId: "openai",
      },
      at: 123,
    })
    expect(written).toMatchObject({
      messageId: "wf:run1:n1",
      sessionId: "wf:run1",
      surface: "workflow",
      model: "gpt-4o",
      providerId: "openai",
      inputTokens: 100,
      cacheReadTokens: 60,
      costUsd: 0.02,
    })
    const list = await listUsageForSession("wf:run1")
    expect(list).toHaveLength(1)
  })

  it("is idempotent per step — a retry overwrites in place", async () => {
    await recordWorkflowStepUsage({
      runId: "r",
      stepId: "n1",
      usage: { inputTokens: 1, outputTokens: 1 },
    })
    await recordWorkflowStepUsage({
      runId: "r",
      stepId: "n1",
      usage: { inputTokens: 9, outputTokens: 9 },
    })
    const list = await listUsageForSession("wf:r")
    expect(list).toHaveLength(1)
    expect(list[0].inputTokens).toBe(9)
  })

  it("skips stub steps that report zero tokens", async () => {
    const written = await recordWorkflowStepUsage({
      runId: "r",
      stepId: "stub",
      usage: { inputTokens: 0, outputTokens: 0 },
    })
    expect(written).toBeNull()
    expect(await getDb().sessionUsage.toArray()).toHaveLength(0)
  })

  it("no-ops without a runId or stepId", async () => {
    expect(
      await recordWorkflowStepUsage({ runId: "", stepId: "n", usage: { inputTokens: 5 } })
    ).toBeNull()
    expect(
      await recordWorkflowStepUsage({ runId: "r", stepId: "", usage: { inputTokens: 5 } })
    ).toBeNull()
  })
})

describe("recordConnectorUsage", () => {
  it("shadow-writes connector usage with a synthetic id and connector surface", async () => {
    const written = await recordConnectorUsage({
      adapterId: "telegram",
      conversationKey: "telegram:thread-1",
      usage: {
        inputTokens: 12,
        outputTokens: 8,
        cacheReadInputTokens: 3,
        cacheCreationInputTokens: 2,
        totalCostUsd: 0.004,
        durationMs: 550,
      },
      at: 123_456,
    })

    expect(written).toMatchObject({
      messageId: "conn:telegram:telegram:thread-1:123456",
      sessionId: "conn:telegram",
      surface: "connector",
      inputTokens: 12,
      outputTokens: 8,
      cacheReadTokens: 3,
      cacheCreationTokens: 2,
      costUsd: 0.004,
      durationMs: 550,
    })
    const list = await listUsageForSession("conn:telegram")
    expect(list).toHaveLength(1)
  })

  it("records a cost-only turn that reported no tokens", async () => {
    // A turn carrying real cost is not an empty turn. Dropping it silently lost
    // spend from the billing table — and disagreed with the chat writer
    // (`recordResultUsage`), which applies no emptiness filter at all.
    const written = await recordConnectorUsage({
      adapterId: "telegram",
      conversationKey: "thread",
      usage: { totalCostUsd: 0.001 },
    })
    expect(written).not.toBeNull()
    expect(written?.costUsd).toBe(0.001)
  })

  it("records a fully cache-served turn with zero fresh input/output tokens", async () => {
    const written = await recordConnectorUsage({
      adapterId: "telegram",
      conversationKey: "cached",
      usage: { cacheReadInputTokens: 17_817 },
    })
    expect(written).not.toBeNull()
    expect(written?.cacheReadTokens).toBe(17_817)
  })

  it("skips genuinely empty connector usage and missing ids", async () => {
    expect(
      await recordConnectorUsage({
        adapterId: "telegram",
        conversationKey: "thread",
        usage: {},
      })
    ).toBeNull()
    expect(
      await recordConnectorUsage({
        adapterId: "",
        conversationKey: "thread",
        usage: { inputTokens: 1 },
      })
    ).toBeNull()
    expect(
      await recordConnectorUsage({
        adapterId: "telegram",
        conversationKey: "",
        usage: { inputTokens: 1 },
      })
    ).toBeNull()
    expect(await getDb().sessionUsage.toArray()).toHaveLength(0)
  })
})

describe("recordGoalUsage", () => {
  it("shadow-writes goal usage with a stable goal turn id and goal surface", async () => {
    const written = await recordGoalUsage({
      goalId: "goal-1",
      turnId: "turn-2",
      usage: {
        inputTokens: 20,
        outputTokens: 11,
        cacheReadInputTokens: 4,
        cacheCreationInputTokens: 2,
        totalCostUsd: 0.006,
        durationMs: 900,
      },
      at: 456,
    })

    expect(written).toMatchObject({
      messageId: "goal:goal-1:turn-2",
      sessionId: "goal:goal-1",
      surface: "goal",
      inputTokens: 20,
      outputTokens: 11,
      cacheReadTokens: 4,
      cacheCreationTokens: 2,
      costUsd: 0.006,
      durationMs: 900,
    })
    const list = await listUsageForSession("goal:goal-1")
    expect(list).toHaveLength(1)
  })

  it("records a cost-only goal turn that reported no tokens", async () => {
    const written = await recordGoalUsage({
      goalId: "goal-1",
      turnId: "turn-1",
      usage: { totalCostUsd: 0.001 },
    })
    expect(written).not.toBeNull()
    expect(written?.costUsd).toBe(0.001)
  })

  it("skips goal usage with empty ids or genuinely empty usage", async () => {
    expect(
      await recordGoalUsage({
        goalId: "goal-1",
        turnId: "turn-1",
        usage: {},
      })
    ).toBeNull()
    expect(
      await recordGoalUsage({
        goalId: "",
        turnId: "turn-1",
        usage: { inputTokens: 1 },
      })
    ).toBeNull()
    expect(
      await recordGoalUsage({
        goalId: "goal-1",
        turnId: "",
        usage: { inputTokens: 1 },
      })
    ).toBeNull()
    expect(await getDb().sessionUsage.toArray()).toHaveLength(0)
  })
})

describe("swallowUsageWrite", () => {
  it("swallows a rejecting shadow-write without throwing", async () => {
    // Must not reject — a failed billing mirror can never break the caller.
    expect(() => swallowUsageWrite(Promise.reject(new Error("dexie down")))).not.toThrow()
    // Let the microtask settle so the internal .catch runs (covers the arrow).
    await new Promise((r) => setTimeout(r, 0))
  })

  it("is a no-op for a resolving promise", async () => {
    swallowUsageWrite(Promise.resolve("ok"))
    await new Promise((r) => setTimeout(r, 0))
  })
})

describe("recordTeamUsage", () => {
  it("shadow-writes an agent-team row keyed by run/teammate/task", async () => {
    const written = await recordTeamUsage({
      runId: "tr1",
      teammateId: "mate-a",
      taskId: "task-7",
      usage: { inputTokens: 30, outputTokens: 12, model: "claude-sonnet-4-6" },
      at: 9,
    })
    expect(written).toMatchObject({
      messageId: "team:tr1:mate-a:task-7",
      sessionId: "team:tr1",
      surface: "agent-team",
      model: "claude-sonnet-4-6",
      inputTokens: 30,
      outputTokens: 12,
    })
  })

  it("no-ops on missing ids", async () => {
    expect(
      await recordTeamUsage({ runId: "", teammateId: "m", taskId: "t", usage: { inputTokens: 1 } })
    ).toBeNull()
    expect(
      await recordTeamUsage({ runId: "r", teammateId: "", taskId: "t", usage: { inputTokens: 1 } })
    ).toBeNull()
  })
})

describe("listUsageForSession", () => {
  it("returns rows sorted by `at` ascending", async () => {
    await upsertSessionUsage(row("m2", "s1", { at: 200 }))
    await upsertSessionUsage(row("m1", "s1", { at: 100 }))
    await upsertSessionUsage(row("m3", "s1", { at: 300 }))
    const list = await listUsageForSession("s1")
    expect(list.map((r) => r.messageId)).toEqual(["m1", "m2", "m3"])
  })

  it("filters out other sessions", async () => {
    await upsertSessionUsage(row("m1", "s1"))
    await upsertSessionUsage(row("m2", "s2"))
    const list = await listUsageForSession("s1")
    expect(list).toHaveLength(1)
    expect(list[0].sessionId).toBe("s1")
  })
})

describe("totalsBySession", () => {
  it("aggregates token + cost + duration totals", async () => {
    await upsertSessionUsage(
      row("m1", "s1", {
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationTokens: 10,
        cacheReadTokens: 20,
        costUsd: 0.01,
        durationMs: 500,
        model: "claude-sonnet-4-5",
      })
    )
    await upsertSessionUsage(
      row("m2", "s1", {
        inputTokens: 200,
        outputTokens: 100,
        costUsd: 0.02,
        durationMs: 700,
        model: "claude-sonnet-4-5",
      })
    )
    const totals = await totalsBySession("s1")
    expect(totals.turns).toBe(2)
    expect(totals.inputTokens).toBe(300)
    expect(totals.outputTokens).toBe(150)
    expect(totals.cacheCreationTokens).toBe(10)
    expect(totals.cacheReadTokens).toBe(20)
    expect(totals.costUsd).toBeCloseTo(0.03)
    expect(totals.durationMs).toBe(1200)
    expect(totals.byModel["claude-sonnet-4-5"]).toBeDefined()
    expect(totals.byModel["claude-sonnet-4-5"].turns).toBe(2)
  })

  it("returns all-zero totals when there are no rows", async () => {
    const totals = await totalsBySession("missing")
    expect(totals.turns).toBe(0)
    expect(totals.costUsd).toBe(0)
    expect(totals.byModel).toEqual({})
  })

  it("buckets unknown model under '(unknown)'", async () => {
    await upsertSessionUsage(row("m1", "s1", { inputTokens: 10 }))
    const totals = await totalsBySession("s1")
    expect(totals.byModel["(unknown)"]).toBeDefined()
  })
})

describe("totalsByAllSessions + topByCost", () => {
  beforeEach(async () => {
    await upsertSessionUsage(row("a1", "s1", { costUsd: 0.5, inputTokens: 1 }))
    await upsertSessionUsage(row("a2", "s1", { costUsd: 0.5 }))
    await upsertSessionUsage(row("b1", "s2", { costUsd: 0.2 }))
    await upsertSessionUsage(row("c1", "s3", { costUsd: 0 })) // no cost, no tokens — skipped
    await upsertSessionUsage(row("d1", "s4", { costUsd: 0.7 }))
  })

  it("totalsByAllSessions buckets every row by sessionId", async () => {
    const map = await totalsByAllSessions()
    expect(map.size).toBe(4)
    expect(map.get("s1")?.turns).toBe(2)
    expect(map.get("s1")?.costUsd).toBeCloseTo(1.0)
  })

  it("topByCost orders by cost desc and skips sessions with no recorded activity", async () => {
    const top = await topByCost(10)
    expect(top.map((r) => r.sessionId)).toEqual(["s1", "s4", "s2"])
  })

  it("topByCost surfaces free / locally-hosted sessions that carry tokens", async () => {
    // Filtering on `costUsd <= 0` used to hide these entirely, so a local model
    // dominating token volume never appeared — and so did every session whose
    // price was merely unknown, which is stored identically to $0.
    await upsertSessionUsage(row("e1", "s5-local", { costUsd: 0, inputTokens: 900_000 }))
    const top = await topByCost(10)
    expect(top.map((r) => r.sessionId)).toContain("s5-local")
    // Ranked below every paid session, but present.
    expect(top[top.length - 1]?.sessionId).toBe("s5-local")
  })

  it("topByCost respects the limit", async () => {
    const top = await topByCost(2)
    expect(top).toHaveLength(2)
    expect(top[0].sessionId).toBe("s1")
    expect(top[1].sessionId).toBe("s4")
  })

  it("topByCost handles zero limit cleanly", async () => {
    expect(await topByCost(0)).toEqual([])
  })

  it("topByCost ties are broken by turns then sessionId", async () => {
    await getDb().sessionUsage.clear()
    await upsertSessionUsage(row("z1", "z-session", { costUsd: 1, durationMs: 0 }))
    await upsertSessionUsage(row("a1", "a-session", { costUsd: 1, durationMs: 0 }))
    await upsertSessionUsage(row("a2", "a-session", { costUsd: 0, durationMs: 0 }))
    // a-session has 2 turns, z-session has 1 — turns tiebreak wins by total
    // turns even when one of those turns is $0.
    const top = await topByCost(10)
    expect(top.map((r) => r.sessionId)).toEqual(["a-session", "z-session"])
  })
})

describe("deleteUsageForSession", () => {
  it("removes every row for the session and leaves others alone", async () => {
    await upsertSessionUsage(row("m1", "s1"))
    await upsertSessionUsage(row("m2", "s1"))
    await upsertSessionUsage(row("m3", "s2"))
    await deleteUsageForSession("s1")
    expect((await listUsageForSession("s1")).length).toBe(0)
    expect((await listUsageForSession("s2")).length).toBe(1)
  })
})

describe("pruneSessionUsageOlderThan", () => {
  it("removes rows older than the retention window and leaves boundary rows", async () => {
    const dayMs = 86_400_000
    const now = Date.UTC(2026, 5, 21, 12)
    await upsertSessionUsage(row("old", "s1", { at: now - 91 * dayMs }))
    await upsertSessionUsage(row("boundary", "s1", { at: now - 90 * dayMs }))
    await upsertSessionUsage(row("fresh", "s2", { at: now - 10 * dayMs }))

    await expect(pruneSessionUsageOlderThan(90, now)).resolves.toBe(1)

    const remaining = (await getDb().sessionUsage.toArray()).map((r) => r.messageId).sort()
    expect(remaining).toEqual(["boundary", "fresh"])
  })

  it("does not prune for disabled or invalid retention windows", async () => {
    await upsertSessionUsage(row("kept", "s1", { at: 1 }))

    await expect(pruneSessionUsageOlderThan(0, 2)).resolves.toBe(0)
    await expect(pruneSessionUsageOlderThan(Number.NaN, 2)).resolves.toBe(0)

    expect(await getDb().sessionUsage.count()).toBe(1)
  })
})

describe("recordResultUsage", () => {
  function makeResult(overrides: Partial<Record<string, unknown>> = {}): SDKResultMessage {
    return {
      type: "result",
      subtype: "success",
      duration_ms: 1200,
      is_error: false,
      total_cost_usd: 0.0123,
      uuid: "u-1",
      session_id: "sdk-1",
      usage: {
        input_tokens: 50,
        output_tokens: 25,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 2,
      },
      ...overrides,
    } as unknown as SDKResultMessage
  }

  it("writes a row when usage is present", async () => {
    const written = await recordResultUsage({
      sessionId: "s1",
      messageId: "msg-1",
      model: "claude-sonnet-4-5",
      providerId: "anthropic",
      result: makeResult(),
    })
    expect(written).not.toBeNull()
    expect(written!.inputTokens).toBe(50)
    expect(written!.outputTokens).toBe(25)
    expect(written!.cacheReadTokens).toBe(5)
    expect(written!.cacheCreationTokens).toBe(2)
    expect(written!.costUsd).toBeCloseTo(0.0123)
    expect(written!.durationMs).toBe(1200)
    const list = await listUsageForSession("s1")
    expect(list).toHaveLength(1)
    expect(list[0].model).toBe("claude-sonnet-4-5")
    expect(list[0].providerId).toBe("anthropic")
  })

  it("returns null when sessionId or messageId is missing", async () => {
    expect(
      await recordResultUsage({ sessionId: "", messageId: "m", result: makeResult() })
    ).toBeNull()
    expect(
      await recordResultUsage({ sessionId: "s", messageId: undefined, result: makeResult() })
    ).toBeNull()
  })

  it("returns null when the result carries no usage payload", async () => {
    const empty = {
      type: "result",
      subtype: "error",
      duration_ms: 100,
      is_error: true,
      uuid: "u-2",
      session_id: "sdk-2",
    } as unknown as SDKResultMessage
    expect(await recordResultUsage({ sessionId: "s1", messageId: "m1", result: empty })).toBeNull()
  })

  it("is idempotent — re-recording the same messageId overwrites", async () => {
    await recordResultUsage({ sessionId: "s1", messageId: "m1", result: makeResult() })
    await recordResultUsage({
      sessionId: "s1",
      messageId: "m1",
      result: makeResult({ total_cost_usd: 0.99 }),
    })
    const list = await listUsageForSession("s1")
    expect(list).toHaveLength(1)
    expect(list[0].costUsd).toBeCloseTo(0.99)
  })

  it("persists reasoning + context tokens when the provider reports them", async () => {
    const written = await recordResultUsage({
      sessionId: "s1",
      messageId: "m-reason",
      result: makeResult({
        usage: {
          input_tokens: 50,
          output_tokens: 25,
          reasoning_tokens: 12,
          context_input_tokens: 4096,
        },
      }),
    })
    expect(written!.reasoningTokens).toBe(12)
    expect(written!.contextInputTokens).toBe(4096)
    const list = await listUsageForSession("s1")
    expect(list[0].reasoningTokens).toBe(12)
    expect(list[0].contextInputTokens).toBe(4096)
  })

  it("omits reasoning/context fields on turns that don't report them", async () => {
    const written = await recordResultUsage({
      sessionId: "s1",
      messageId: "m-plain",
      result: makeResult(),
    })
    expect(written!.reasoningTokens).toBeUndefined()
    expect(written!.contextInputTokens).toBeUndefined()
  })

  it("captures cost-only results without a usage object", async () => {
    const costOnly = {
      type: "result",
      subtype: "success",
      duration_ms: 300,
      is_error: false,
      total_cost_usd: 0.05,
      uuid: "u-3",
      session_id: "sdk-3",
    } as unknown as SDKResultMessage
    const written = await recordResultUsage({
      sessionId: "s1",
      messageId: "m-cost-only",
      result: costOnly,
    })
    expect(written).not.toBeNull()
    expect(written!.inputTokens).toBe(0)
    expect(written!.costUsd).toBeCloseTo(0.05)
  })
})

describe("v172 frozen cost + identity capture", () => {
  function resultWith(usage: Record<string, unknown>, costUsd = 0) {
    return {
      type: "result",
      subtype: "success",
      total_cost_usd: costUsd,
      duration_ms: 100,
      usage,
    } as unknown as Parameters<typeof recordResultUsage>[0]["result"]
  }

  it("freezes an SDK-reported cost as authoritative", () => {
    return recordResultUsage({
      sessionId: "s1",
      messageId: "m-sdk",
      result: resultWith({ input_tokens: 10, output_tokens: 5 }, 0.25),
    }).then((row) => {
      expect(row).toMatchObject({ costUsd: 0.25, costSource: "sdk", costKnown: true })
    })
  })

  it("marks a zero-cost turn unknown rather than free", () => {
    // The non-Anthropic dispatch paths always report 0; treating that as "free"
    // is what made unpriced spend invisible.
    return recordResultUsage({
      sessionId: "s1",
      messageId: "m-zero",
      result: resultWith({ input_tokens: 10, output_tokens: 5 }, 0),
    }).then((row) => {
      expect(row).toMatchObject({ costSource: "unknown", costKnown: false })
    })
  })

  it("persists the cache-TTL split when the provider reports it", () => {
    return recordResultUsage({
      sessionId: "s1",
      messageId: "m-ttl",
      result: resultWith({
        input_tokens: 86,
        cache_creation_input_tokens: 7345,
        cache_creation: {
          ephemeral_5m_input_tokens: 5000,
          ephemeral_1h_input_tokens: 2345,
        },
      }),
    }).then((row) => {
      expect(row?.cacheCreation5mTokens).toBe(5000)
      expect(row?.cacheCreation1hTokens).toBe(2345)
      // The flat total is still carried for callers that don't split.
      expect(row?.cacheCreationTokens).toBe(7345)
    })
  })

  it("omits the TTL split when the provider reports only a flat total", () => {
    return recordResultUsage({
      sessionId: "s1",
      messageId: "m-flat",
      result: resultWith({ input_tokens: 5, cache_creation_input_tokens: 500 }),
    }).then((row) => {
      expect(row?.cacheCreation5mTokens).toBeUndefined()
      expect(row?.cacheCreation1hTokens).toBeUndefined()
    })
  })

  it("persists server-tool invocation counts", () => {
    // Web search bills $10 per 1,000 requests — dropping the count made that
    // spend structurally unrepresentable.
    return recordResultUsage({
      sessionId: "s1",
      messageId: "m-tools",
      result: resultWith({
        input_tokens: 105,
        output_tokens: 6039,
        server_tool_use: { web_search: 3 },
      }),
    }).then((row) => {
      expect(row?.unitBreakdown?.requests).toEqual({ web_search: 3 })
    })
  })

  it("carries the execution identity and pricing modifiers onto the row", () => {
    return recordResultUsage({
      sessionId: "s1",
      messageId: "m-identity",
      result: resultWith({ input_tokens: 1 }, 0.01),
      projectId: "p1",
      runId: "run-1",
      turnId: "turn-1",
      attemptId: "attempt-1",
      speed: "fast",
      inferenceGeo: "us",
      batch: false,
    }).then((row) => {
      expect(row).toMatchObject({
        projectId: "p1",
        runId: "run-1",
        turnId: "turn-1",
        attemptId: "attempt-1",
        speed: "fast",
        inferenceGeo: "us",
        batch: false,
      })
    })
  })

  it("records a shadow turn that carried only 1-hour cache writes", async () => {
    // Previously dropped: no fresh tokens, no flat cache total, no cost.
    const row = await recordWorkflowStepUsage({
      runId: "r1",
      stepId: "s1",
      usage: { cacheCreation1hTokens: 2345 },
    })
    expect(row).not.toBeNull()
    expect(row?.cacheCreation1hTokens).toBe(2345)
  })

  it("records a shadow turn that carried only server-tool calls", async () => {
    const row = await recordWorkflowStepUsage({
      runId: "r2",
      stepId: "s2",
      usage: { unitBreakdown: { requests: { web_search: 1 } } },
    })
    expect(row).not.toBeNull()
    expect(row?.unitBreakdown?.requests).toEqual({ web_search: 1 })
  })
})

describe("recordSurfaceUsage — non-conversational surfaces", () => {
  it("records an embedding batch under its own surface and scope", async () => {
    const row = await recordSurfaceUsage({
      surface: "embedding",
      operationId: "job-1",
      scopeId: "twin-7",
      usage: { inputTokens: 12_000, providerId: "openai", model: "text-embedding-3-small" },
    })
    expect(row).toMatchObject({
      messageId: "embedding:job-1",
      sessionId: "embedding:twin-7",
      surface: "embedding",
      inputTokens: 12_000,
    })
  })

  it("is idempotent so a retried job overwrites instead of double-billing", async () => {
    await recordSurfaceUsage({
      surface: "twin",
      operationId: "job-2",
      usage: { inputTokens: 100, outputTokens: 50 },
    })
    await recordSurfaceUsage({
      surface: "twin",
      operationId: "job-2",
      usage: { inputTokens: 200, outputTokens: 60 },
    })
    const rows = await getDb().sessionUsage.where("sessionId").equals("twin:twin").toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0].inputTokens).toBe(200)
  })

  it("records a page-billed OCR run that reports no tokens at all", async () => {
    const row = await recordSurfaceUsage({
      surface: "ocr",
      operationId: "doc-1",
      usage: { unitBreakdown: { pages: 120 }, costUsd: 0.36 },
    })
    // Tokens are all zero here; only the page count and cost make it non-empty.
    expect(row?.unitBreakdown?.pages).toBe(120)
    expect(row?.costUsd).toBeCloseTo(0.36)
  })

  it("records a character-billed TTS utterance", async () => {
    const row = await recordSurfaceUsage({
      surface: "tts",
      operationId: "utt-1",
      usage: { unitBreakdown: { characters: 4_200 }, providerId: "elevenlabs" },
    })
    expect(row?.unitBreakdown?.characters).toBe(4_200)
    expect(row?.surface).toBe("tts")
  })

  it("refuses a call with no surface or no operation id", async () => {
    expect(
      await recordSurfaceUsage({ surface: "ocr", operationId: "", usage: { inputTokens: 1 } })
    ).toBeNull()
  })

  it("still skips a genuinely empty operation", async () => {
    expect(
      await recordSurfaceUsage({ surface: "memory", operationId: "noop", usage: {} })
    ).toBeNull()
  })
})

describe("imported spend provenance", () => {
  it("marks an imported row and keeps it out of local totals", async () => {
    await upsertSessionUsage({
      messageId: "local-1",
      sessionId: "s-local",
      at: 1,
      inputTokens: 100,
      outputTokens: 100,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      costUsd: 1,
      durationMs: 0,
    })
    const imported = await recordImportedUsage({
      operationId: "msg-9",
      sessionId: "s-local",
      usage: { inputTokens: 500, outputTokens: 500, costUsd: 9 },
    })
    expect(imported).toMatchObject({ imported: true, surface: "imported" })

    // This spend was paid in another agent, on another machine — counting it
    // would inflate "what this install cost me".
    const local = await totalsByAllSessions()
    expect(local.get("s-local")?.costUsd).toBeCloseTo(1)

    const all = await totalsByAllSessions({ includeImported: true })
    expect(all.get("s-local")?.costUsd).toBeCloseTo(10)
  })

  it("classifies rows with isLocalSpend", () => {
    expect(isLocalSpend({ imported: undefined })).toBe(true)
    expect(isLocalSpend({ imported: false })).toBe(true)
    expect(isLocalSpend({ imported: true })).toBe(false)
  })

  it("refuses an imported row with no source id or session", async () => {
    expect(
      await recordImportedUsage({ operationId: "", sessionId: "s", usage: { costUsd: 1 } })
    ).toBeNull()
  })
})
