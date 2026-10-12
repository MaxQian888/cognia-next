/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { getDb, __resetDbForTesting } from "@/lib/db/schema"
import { completeBotRunStep } from "@/lib/db/bot-run-steps"
import { recordBotInvocationCost } from "@/lib/bot/runtime/run-cost"
import { readExecutionRunDetailSources } from "./run-detail-source"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
})
it("reads exact Bot approval and result from their existing run-scoped records", async () => {
  await getDb().executionRuns.put({
    id: "bot",
    kind: "bot",
    sourceId: "install",
    title: "Bot",
    status: "waiting",
    currentRevision: 2,
    startedAt: 1,
    updatedAt: 1,
  })
  await getDb().executionRunEvents.bulkPut([
    {
      id: "private",
      runId: "bot",
      seq: 1,
      ts: 1,
      type: "resource.changed",
      visibility: "private",
      payload: { path: "/private" },
    },
    {
      id: "visible",
      runId: "bot",
      seq: 2,
      ts: 2,
      type: "step.completed",
      visibility: "summary",
      payload: {},
    },
  ])
  const detail = {
    snapshot: { id: "digest", diff: "exact approved diff" },
    approvedActions: [{ actionId: "openPr", input: { title: "Fix" } }],
  }
  await getDb().executionRunInterrupts.bulkPut([
    {
      id: "approval",
      runId: "bot",
      type: "bot_approval",
      status: "pending",
      title: "Publish",
      approvalDetail: detail,
      createdAt: 1,
      expiresAt: 100,
    },
    {
      id: "foreign",
      runId: "other",
      type: "bot_approval",
      status: "pending",
      title: "Other",
      createdAt: 1,
      expiresAt: 100,
    },
  ])
  await completeBotRunStep("bot", "__host:result", {
    status: "completed",
    output: { review: "result" },
  })
  const result = await readExecutionRunDetailSources("bot")
  expect(result.events.map((event) => event.id)).toEqual(["visible"])
  expect(result.interrupts).toEqual([
    expect.objectContaining({ id: "approval", approvalDetail: detail }),
  ])
  expect(result.botResult).toEqual({ status: "completed", output: { review: "result" } })
  expect((await readExecutionRunDetailSources("bot", true)).events).toHaveLength(2)
})
it("returns no unrelated records for a missing run and rejects malformed IDs", async () => {
  await expect(readExecutionRunDetailSources("missing")).resolves.toEqual({
    events: [],
    interrupts: [],
  })
  await expect(readExecutionRunDetailSources("")).rejects.toThrow("runId")
})
it("summarizes a Bot run's model spend from its cost ledger, and omits it when nothing was called", async () => {
  await getDb().executionRuns.put({
    id: "bot",
    kind: "bot",
    sourceId: "install",
    title: "Bot",
    status: "running",
    currentRevision: 0,
    startedAt: 1,
    updatedAt: 1,
  })
  expect((await readExecutionRunDetailSources("bot")).botCost).toBeUndefined()
  await recordBotInvocationCost("bot", "answer", {
    costUsd: 0.25,
    source: "pricing",
    inputTokens: 1000,
    outputTokens: 200,
  })
  await recordBotInvocationCost("bot", "review", {
    costUsd: null,
    source: "unknown",
    inputTokens: 10,
    outputTokens: 2,
  })
  expect((await readExecutionRunDetailSources("bot")).botCost).toEqual({
    spentUsd: 0.25,
    unpricedInvocations: 1,
    invocations: 2,
  })
})
