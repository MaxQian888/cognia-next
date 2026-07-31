/** @jest-environment jsdom */
// Coverage for the session-usage CRUD + aggregator layer.

import "fake-indexeddb/auto"
import {
  deleteUsageForSession,
  listUsageForSession,
  pruneSessionUsageOlderThan,
  recordConnectorUsage,
  recordGoalUsage,
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
import { __resetDbForTesting, getDb, whenSeeded } from "./schema"
import type { SDKResultMessage } from "@cognia/agent-config-types"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await getDb().sessionUsage.clear()
})

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

  it("skips empty connector usage and missing ids", async () => {
    expect(
      await recordConnectorUsage({
        adapterId: "telegram",
        conversationKey: "thread",
        usage: { totalCostUsd: 0.001 },
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

  it("skips goal usage with empty ids or empty token usage", async () => {
    expect(
      await recordGoalUsage({
        goalId: "goal-1",
        turnId: "turn-1",
        usage: { totalCostUsd: 0.001 },
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
    await upsertSessionUsage(row("c1", "s3", { costUsd: 0 })) // free turn — skipped
    await upsertSessionUsage(row("d1", "s4", { costUsd: 0.7 }))
  })

  it("totalsByAllSessions buckets every row by sessionId", async () => {
    const map = await totalsByAllSessions()
    expect(map.size).toBe(4)
    expect(map.get("s1")?.turns).toBe(2)
    expect(map.get("s1")?.costUsd).toBeCloseTo(1.0)
  })

  it("topByCost orders by cost desc and skips zero-cost sessions", async () => {
    const top = await topByCost(10)
    expect(top.map((r) => r.sessionId)).toEqual(["s1", "s4", "s2"])
    expect(top.every((r) => r.totals.costUsd > 0)).toBe(true)
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
