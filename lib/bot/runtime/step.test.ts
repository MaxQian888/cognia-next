/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import { enqueueBotDelivery } from "@/lib/db/bot-event-deliveries"
import { getBotRunStep } from "@/lib/db/bot-run-steps"
import { createExecutionRun, runEventJournal } from "@/lib/db/execution-runs"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import type { BotEventEnvelopeV1 } from "@/types/bot/event"
import type { ExecutionRun } from "@/types/execution/run"

import { BotRunCancelledError, botApprovalInterruptId, createBotStepApi } from "./step"

const NOW = 1_700_000_000_000
const RUN_ID = "run_bot_1"

let clock = NOW
const now = () => clock
const sleep = async () => {
  // Advance far enough that a polling wait makes progress toward its deadline
  // without any real timers.
  clock += 500
}

function api(signal = new AbortController().signal) {
  return createBotStepApi({
    runId: RUN_ID,
    signal,
    deps: { now, sleep, pollIntervalMs: 1 },
  })
}

async function seedRun(): Promise<ExecutionRun> {
  return createExecutionRun({
    id: RUN_ID,
    kind: "bot",
    sourceId: "boti_1",
    title: "Digest",
    status: "running",
    currentRevision: 0,
    startedAt: NOW,
    updatedAt: NOW,
  })
}

function envelope(correlation: string): BotEventEnvelopeV1 {
  return {
    eventId: "bev_ci",
    deliveryId: "bdl_ci",
    source: "integration",
    type: "workflow_run.completed",
    installationId: "boti_1",
    triggerId: "ci",
    occurredAt: NOW,
    receivedAt: NOW,
    payload: { conclusion: "success" },
    provenance: { selfProduced: false, depth: 0 },
    correlation,
  }
}

beforeEach(async () => {
  __resetDbForTesting()
  clock = NOW
  const db = getDb()
  await db.botRunSteps.clear()
  await db.executionRuns.clear()
  await db.executionRunEvents.clear()
  await db.executionRunInterrupts.clear()
  await db.botEventDeliveries.clear()
  await seedRun()
}, 15_000)

describe("botApprovalInterruptId", () => {
  it("is derived, so a re-entry finds the same pending decision", () => {
    expect(botApprovalInterruptId("run_1", "send")).toBe(botApprovalInterruptId("run_1", "send"))
    expect(botApprovalInterruptId("run_1", "send")).not.toBe(
      botApprovalInterruptId("run_1", "other")
    )
  })
})

describe("step.run", () => {
  it("runs the function once and returns its value", async () => {
    const fn = jest.fn().mockResolvedValue({ issues: 2 })
    expect(await api().run("fetch", fn)).toEqual({ issues: 2 })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it("does not call the function again after a re-entry", async () => {
    const fn = jest.fn().mockResolvedValue("first")
    await api().run("fetch", fn)

    const second = jest.fn().mockResolvedValue("second")
    // This IS the resume: a fresh step API over the same run id.
    expect(await api().run("fetch", second)).toBe("first")
    expect(second).not.toHaveBeenCalled()
  })

  it("writes the timeline events without putting the output in them", async () => {
    await api().run("fetch", async () => ({ url: "https://api.github.com/x" }))

    const events = await runEventJournal.replay(RUN_ID)
    const types = events.map((e) => e.type)
    expect(types).toContain("step.started")
    expect(types).toContain("step.completed")
    // The journal redacts strings, so the value lives in the checkpoint store.
    expect(JSON.stringify(events)).not.toContain("api.github.com")
    expect(await getBotRunStep(RUN_ID, "fetch")).toMatchObject({
      output: { url: "https://api.github.com/x" },
    })
  })

  it("records a failure and rethrows, so the delivery can decide to retry", async () => {
    await expect(
      api().run("fetch", () => {
        throw new Error("upstream 500")
      })
    ).rejects.toThrow("upstream 500")

    expect(await getBotRunStep(RUN_ID, "fetch")).toMatchObject({
      status: "failed",
      error: "upstream 500",
    })
  })

  it("re-runs a failed step on the next entry", async () => {
    await api()
      .run("fetch", () => {
        throw new Error("boom")
      })
      .catch(() => undefined)

    const retry = jest.fn().mockResolvedValue("ok")
    expect(await api().run("fetch", retry)).toBe("ok")
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it("refuses to start a step once the run is cancelled", async () => {
    const controller = new AbortController()
    controller.abort()
    const fn = jest.fn()

    await expect(api(controller.signal).run("fetch", fn)).rejects.toThrow(BotRunCancelledError)
    expect(fn).not.toHaveBeenCalled()
  })
})

describe("step.waitForApproval", () => {
  it("parks on a pending interrupt and resolves when a person answers", async () => {
    const pending = api().waitForApproval("send", { title: "Post the digest?" })

    // Let the loop poll once, then answer.
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
    const interruptId = botApprovalInterruptId(RUN_ID, "send")
    const row = await getDb().executionRunInterrupts.get(interruptId)
    expect(row?.type).toBe("bot_approval")
    await getDb().executionRunInterrupts.put({
      ...row!,
      status: "approved",
      resolvedAt: NOW + 10,
      resolvedBy: { displayName: "Ada" },
    })

    const decision = await pending
    expect(decision.outcome).toBe("approved")
    expect(decision.decidedBy?.displayName).toBe("Ada")
  })

  it("reports an expiry rather than treating silence as a yes", async () => {
    const decision = await api().waitForApproval("send", {
      title: "Post the digest?",
      timeoutMs: 1_000,
    })
    expect(decision.outcome).toBe("expired")
    expect(decision.decidedBy).toBeUndefined()
  })

  it("memoizes the decision, so a resumed handler does not ask twice", async () => {
    await api().waitForApproval("send", { title: "Post?", timeoutMs: 1_000 })
    const before = await getDb().executionRunInterrupts.count()

    const again = await api().waitForApproval("send", { title: "Post?", timeoutMs: 1_000 })
    expect(again.outcome).toBe("expired")
    expect(await getDb().executionRunInterrupts.count()).toBe(before)
  })

  it("does not restart the deadline on a re-entry", async () => {
    // Enter once and abandon the wait, the way a killed process would.
    const controller = new AbortController()
    const first = api(controller.signal)
      .waitForApproval("send", { title: "Post?", timeoutMs: 60_000 })
      .catch(() => undefined)
    await Promise.resolve()
    controller.abort()
    await first

    const created = await getDb().executionRunInterrupts.get(botApprovalInterruptId(RUN_ID, "send"))
    const originalExpiry = created?.expiresAt

    clock = NOW + 30_000
    const resumed = api()
      .waitForApproval("send", { title: "Post?", timeoutMs: 60_000 })
      .catch(() => undefined)
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))

    const after = await getDb().executionRunInterrupts.get(botApprovalInterruptId(RUN_ID, "send"))
    // A wait that silently extends itself on every restart never ends.
    expect(after?.expiresAt).toBe(originalExpiry)
    await getDb().executionRunInterrupts.put({ ...after!, status: "denied", resolvedAt: clock })
    await resumed
  })
})

describe("step.waitForEvent", () => {
  it("returns the envelope when a correlated delivery arrives", async () => {
    await enqueueBotDelivery({ envelope: envelope("ci:run-42"), now: NOW })

    const result = await api().waitForEvent("ci", { key: "ci:run-42", timeoutMs: 10_000 })
    expect(result?.eventId).toBe("bev_ci")
  })

  it("resolves to null on timeout, because never arriving is an ordinary branch", async () => {
    expect(await api().waitForEvent("ci", { key: "ci:run-99", timeoutMs: 1_000 })).toBeNull()
  })

  it("memoizes a timeout, so a resumed handler does not wait again", async () => {
    await api().waitForEvent("ci", { key: "ci:run-99", timeoutMs: 1_000 })
    await enqueueBotDelivery({ envelope: envelope("ci:run-99"), now: NOW })

    // The wait already concluded. A late arrival does not un-conclude it.
    expect(await api().waitForEvent("ci", { key: "ci:run-99", timeoutMs: 1_000 })).toBeNull()
  })

  it("refuses to start once the run is cancelled", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      api(controller.signal).waitForEvent("ci", { key: "k", timeoutMs: 1_000 })
    ).rejects.toThrow(BotRunCancelledError)
  })
})
