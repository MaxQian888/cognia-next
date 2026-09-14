/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import { enqueueBotDelivery, listBotDeliveries } from "@/lib/db/bot-event-deliveries"
import { installBot } from "@/lib/db/bot-installations"
import { getBotRunStep } from "@/lib/db/bot-run-steps"
import type { BotEventDeliveryRow, BotInstallationRow } from "@/lib/db/bot-types"
import { getExecutionRun, runEventJournal } from "@/lib/db/execution-runs"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import type { InstalledBot } from "@/lib/bot/installed-bot"
import type { BotEventEnvelopeV1 } from "@/types/bot/event"

import { BotExecutorUnavailableError, type BotExecutorContext } from "./executors/types"
import { BotRunParkedError } from "./step"
import {
  __resetLiveBotRunsForTesting,
  botRunId,
  cancelBotRun,
  cancelLiveBotInstallation,
  cancelLiveBotRun,
  getLiveBotRunSignal,
  runBotDelivery,
} from "./run"

const NOW = 1_700_000_000_000
const now = () => NOW

function envelope(): BotEventEnvelopeV1 {
  return {
    eventId: "bev_1",
    deliveryId: "bdl_1",
    source: "integration",
    type: "pull_request.opened",
    installationId: "boti_1",
    triggerId: "opened",
    occurredAt: NOW,
    receivedAt: NOW,
    payload: { number: 42 },
    provenance: { selfProduced: false, depth: 0 },
    actor: { kind: "human", id: "octocat", displayName: "Octocat" },
  }
}

async function seed(): Promise<{ delivery: BotEventDeliveryRow; resolved: InstalledBot }> {
  const installation: BotInstallationRow = await installBot({
    id: "boti_1",
    definitionId: "acme:digest",
    definitionSource: "plugin",
    pinnedVersion: "1.0.0",
    scope: { kind: "account" },
    config: { channel: "#ops" },
    now: NOW,
  })
  const delivery = await enqueueBotDelivery({ envelope: envelope(), now: NOW })
  return {
    delivery,
    resolved: {
      installation,
      definition: {
        id: "acme:digest",
        name: "Digest",
        version: "1.0.0",
        executor: "handler",
        triggers: [{ id: "opened", kind: "manual" }],
        source: "plugin",
      },
      policy: {},
      // The audit trail beside the ceiling. Empty here because no layer has an
      // opinion, which `resolveBotPolicy([])` is the honest way to spell.
      policyResolution: { policy: {}, provenance: {}, refusals: [] },
      problems: [],
    },
  }
}

beforeEach(async () => {
  __resetDbForTesting()
  __resetLiveBotRunsForTesting()
  const db = getDb()
  await db.botInstallations.clear()
  await db.botEventDeliveries.clear()
  await db.botRunSteps.clear()
  await db.executionRuns.clear()
  await db.executionRunEvents.clear()
  await db.executionRunInterrupts.clear()
}, 15_000)

describe("botRunId", () => {
  it("is derived from the delivery, so a re-entry finds its own state", () => {
    expect(botRunId("bdl_1")).toBe(botRunId("bdl_1"))
    expect(botRunId("bdl_1")).not.toBe(botRunId("bdl_2"))
  })
})

describe("runBotDelivery", () => {
  it("does not dispatch work after its host has stopped", async () => {
    const { delivery, resolved } = await seed()
    const host = new AbortController()
    host.abort()
    const handler = jest.fn()
    const outcome = await runBotDelivery({
      delivery,
      resolved,
      now,
      signal: host.signal,
      executors: { handler },
    })
    expect(outcome.status).toBe("cancelled")
    expect(handler).not.toHaveBeenCalled()
    expect((await getDb().botEventDeliveries.get(delivery.id))?.attempts).toBe(0)
  })

  it("cancels execution at the policy deadline and releases its timer", async () => {
    const { delivery, resolved } = await seed()
    resolved.policy.maxRunDurationMs = 25
    const outcome = await runBotDelivery({
      delivery,
      resolved,
      now,
      executors: {
        handler: (ctx) =>
          new Promise((resolve) => {
            ctx.signal.addEventListener("abort", () => resolve({ summary: "aborted" }), {
              once: true,
            })
          }),
      },
    })
    expect(outcome.status).toBe("cancelled")
    expect((await getDb().botEventDeliveries.get(delivery.id))?.status).toBe("dismissed")
    expect(getLiveBotRunSignal(outcome.runId)).toBeUndefined()
  })

  it("does not consume execution time while approval is parked", async () => {
    const { delivery, resolved } = await seed()
    resolved.policy.maxRunDurationMs = 25
    let signal: AbortSignal | undefined
    const outcome = await runBotDelivery({
      delivery,
      resolved,
      now,
      executors: {
        handler: async (ctx) => {
          signal = ctx.signal
          throw new BotRunParkedError(ctx.runId, "publish", NOW + 60_000)
        },
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(outcome.status).toBe("parked")
    expect(signal?.aborted).toBe(false)
    expect((await getDb().botEventDeliveries.get(delivery.id))?.attempts).toBe(0)
  })

  it("keeps permanent failures terminal and refuses silent redispatch", async () => {
    const { delivery, resolved } = await seed()
    const handler = jest.fn(() => {
      throw new Error("403 forbidden")
    })
    const outcome = await runBotDelivery({ delivery, resolved, now, executors: { handler } })
    expect(outcome.status).toBe("failed")
    expect((await getDb().botEventDeliveries.get(delivery.id))?.status).toBe("deadletter")
    const before = await getExecutionRun(outcome.runId)
    const retry = await runBotDelivery({ delivery, resolved, now, executors: { handler } })
    expect(retry.status).toBe("unavailable")
    expect(handler).toHaveBeenCalledTimes(1)
    expect(await getExecutionRun(outcome.runId)).toEqual(before)
  })

  it("preserves progress and verified actor attribution in the shared run journal", async () => {
    const { delivery, resolved } = await seed()
    delivery.envelope.actor = { kind: "human", principalId: "principal", accountId: "account" }
    resolved.installation.projectId = "project"
    await runBotDelivery({
      delivery,
      resolved,
      now,
      cwd: "/fixture",
      executors: {
        handler: async (ctx) => {
          ctx.log("info", "Fetched current revision")
          ctx.log("error", "Verification requires attention", { command: "test" })
          ctx.progress({ message: "Inspecting diff" })
          // A durable step gives asynchronous journal appends time to settle.
          await ctx.step.run("report", () => ({ ok: true }))
          return { summary: "ready" }
        },
      },
    })
    const run = await getExecutionRun(botRunId(delivery.id))
    expect(run?.projectId).toBe("project")
    expect(run?.initiator).toEqual({ principalId: "principal", accountId: "account" })
    const events = await runEventJournal.replay(botRunId(delivery.id))
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "step.progress" }),
        expect.objectContaining({ type: "step.failed" }),
        expect.objectContaining({ type: "run.completed" }),
      ])
    )
  })

  it("does not cancel mirrored or non-Bot work through the Bot API", async () => {
    const { delivery, resolved } = await seed()
    await runBotDelivery({
      delivery,
      resolved,
      now,
      executors: {
        handler: async () => {
          throw new BotRunParkedError(botRunId(delivery.id), "publish", NOW + 100)
        },
      },
    })
    await getDb().botEventDeliveries.update(delivery.id, { syncedFromHost: true })
    expect(await cancelBotRun(botRunId(delivery.id))).toBe(false)
    expect((await getExecutionRun(botRunId(delivery.id)))?.status).toBe("waiting")
    await getDb().executionRuns.update(botRunId(delivery.id), { kind: "agent-turn" })
    expect(await cancelBotRun(botRunId(delivery.id))).toBe(false)
  })
  it("retains blocked result artifacts and exposes actionable failure without replaying", async () => {
    const { delivery, resolved } = await seed()
    const result = {
      summary: "Fork cannot publish",
      output: { status: "blocked", snapshot: { diff: "+patch" } },
    }
    expect(
      (
        await runBotDelivery({
          delivery,
          resolved,
          now,
          executors: { handler: async () => result },
        })
      ).status
    ).toBe("unavailable")
    expect((await getBotRunStep(botRunId(delivery.id), "__host:result"))?.output).toEqual(result)
    expect((await getExecutionRun(botRunId(delivery.id)))?.latestSnapshot?.status).toBe("failed")
  })
  it("cancels an installation's active execution and keeps its host signal authoritative", async () => {
    const { delivery, resolved } = await seed()
    const outcome = await runBotDelivery({
      delivery,
      resolved,
      now,
      executors: {
        handler: async (ctx) => {
          expect(getLiveBotRunSignal(ctx.runId)?.aborted).toBe(false)
          cancelLiveBotInstallation(resolved.installation.id)
          expect(getLiveBotRunSignal(ctx.runId)?.aborted).toBe(true)
          return { summary: "must not become success" }
        },
      },
    })
    expect(outcome.status).toBe("cancelled")
    expect(getLiveBotRunSignal(outcome.runId)).toBeUndefined()
  })
  it("rejects cancellation of missing and settled runs", async () => {
    expect(await cancelBotRun("missing")).toBe(false)
    const { delivery, resolved } = await seed()
    const result = await runBotDelivery({
      delivery,
      resolved,
      now,
      executors: { handler: async () => ({}) },
    })
    expect(await cancelBotRun(result.runId)).toBe(false)
  })
  it("creates a bot ExecutionRun and settles it completed", async () => {
    const { delivery, resolved } = await seed()
    const executor = jest.fn().mockResolvedValue({ summary: "posted" })

    const outcome = await runBotDelivery({
      delivery,
      resolved,
      now,
      executors: { handler: executor },
    })

    expect(outcome).toMatchObject({ status: "completed", runId: botRunId(delivery.id) })
    const run = await getExecutionRun(botRunId(delivery.id))
    expect(run?.kind).toBe("bot")
    expect(run?.status).toBe("completed")
    expect(run?.sourceId).toBe("boti_1")
  })

  it("attributes the run to the verified human behind the event", async () => {
    const { delivery, resolved } = await seed()
    await runBotDelivery({ delivery, resolved, now, executors: { handler: jest.fn() } })

    const run = await getExecutionRun(botRunId(delivery.id))
    expect(run?.initiator).toMatchObject({ platformIdentityId: "octocat", displayName: "Octocat" })
  })

  it("hands the executor the resolved config, defaults included", async () => {
    const { delivery, resolved } = await seed()
    resolved.definition.configSchema = {
      properties: { channel: { default: "#default" }, limit: { default: 5 } },
    }
    const executor = jest.fn()

    await runBotDelivery({ delivery, resolved, now, executors: { handler: executor } })

    expect(executor.mock.calls[0][0].config).toEqual({ channel: "#ops", limit: 5 })
  })

  it("settles the delivery, so the queue does not retry a success", async () => {
    const { delivery, resolved } = await seed()
    await runBotDelivery({ delivery, resolved, now, executors: { handler: jest.fn() } })

    expect((await listBotDeliveries({ status: "succeeded" })).map((d) => d.id)).toEqual([
      delivery.id,
    ])
  })

  it("backs the delivery off when the work ran and failed", async () => {
    const { delivery, resolved } = await seed()
    const outcome = await runBotDelivery({
      delivery,
      resolved,
      now,
      executors: {
        handler: () => {
          throw new Error("upstream 500")
        },
      },
    })

    expect(outcome.status).toBe("failed")
    const row = await getDb().botEventDeliveries.get(delivery.id)
    expect(row?.status).toBe("pending")
    expect(row?.attempts).toBe(1)
    expect((await getExecutionRun(botRunId(delivery.id)))?.status).toBe("waiting")
  })

  it("dismisses rather than retries when nothing could run at all", async () => {
    const { delivery, resolved } = await seed()
    const outcome = await runBotDelivery({
      delivery,
      resolved,
      now,
      executors: {
        handler: () => {
          throw new BotExecutorUnavailableError("handler", "plugin is disabled")
        },
      },
    })

    // Retrying the same delivery changes nothing, so the attempt budget is
    // kept for failures a retry could actually fix.
    expect(outcome.status).toBe("unavailable")
    const row = await getDb().botEventDeliveries.get(delivery.id)
    expect(row?.status).toBe("dismissed")
    expect(row?.attempts).toBe(0)
  })

  it("records a cancellation as cancelled, not as a failure", async () => {
    const { delivery, resolved } = await seed()
    const runId = botRunId(delivery.id)

    const outcome = await runBotDelivery({
      delivery,
      resolved,
      now,
      executors: {
        handler: async (ctx) => {
          cancelLiveBotRun(ctx.runId)
          await ctx.step.run("after-cancel", () => "never")
        },
      },
    })

    expect(outcome).toEqual({ status: "cancelled", runId })
    expect((await getExecutionRun(runId))?.status).toBe("cancelled")
    expect((await getDb().botEventDeliveries.get(delivery.id))?.status).toBe("dismissed")
  })

  it("reuses the run on a re-entry, so completed steps stay memoized", async () => {
    const { delivery, resolved } = await seed()
    const work = jest.fn().mockResolvedValue("fetched")

    await runBotDelivery({
      delivery,
      resolved,
      now,
      executors: {
        handler: async (ctx) => {
          await ctx.step.run("fetch", work)
          throw new Error("crashed after the step")
        },
      },
    }).catch(() => undefined)

    expect(await getBotRunStep(botRunId(delivery.id), "fetch")).toMatchObject({
      status: "completed",
    })

    const retryDelivery = (await getDb().botEventDeliveries.get(delivery.id))!
    await runBotDelivery({
      delivery: retryDelivery,
      resolved,
      now,
      executors: {
        handler: async (ctx) => {
          await ctx.step.run("fetch", work)
        },
      },
    })

    // The whole point of deriving the run id from the delivery.
    expect(work).toHaveBeenCalledTimes(1)
    expect((await getExecutionRun(botRunId(delivery.id)))?.latestSnapshot?.status).toBe("completed")
  })

  it("writes a run.started event once, however many attempts there are", async () => {
    const { delivery, resolved } = await seed()
    await runBotDelivery({
      delivery,
      resolved,
      now,
      executors: {
        handler: () => {
          throw new Error("boom")
        },
      },
    })
    const retry = (await getDb().botEventDeliveries.get(delivery.id))!
    await runBotDelivery({ delivery: retry, resolved, now, executors: { handler: jest.fn() } })

    const events = await runEventJournal.replay(botRunId(delivery.id))
    expect(events.filter((e) => e.type === "run.started")).toHaveLength(1)
  })

  it("carries a poll cursor forward from the handler's result", async () => {
    const { delivery, resolved } = await seed()
    resolved.definition.triggers = [{ id: "opened", kind: "poll", everyMs: 60_000 }]
    const { readBotTriggerState } = await import("@/lib/db/bot-installations")

    await runBotDelivery({
      delivery,
      resolved,
      now,
      executors: { handler: async () => ({ output: { cursor: "page-3" } }) },
    })

    // The host cannot compute a cursor, but remembering the last one is the
    // difference between polling forward and polling the same page forever.
    expect(await readBotTriggerState("boti_1", "opened")).toMatchObject({
      cursor: "page-3",
      lastFiredAt: NOW,
    })
  })

  it("carries a derived-state edge forward, so the handler can tell a change", async () => {
    const { delivery, resolved } = await seed()
    resolved.definition.triggers = [
      { id: "opened", kind: "derivedState", everyMs: 60_000, state: "stale" },
    ]
    const { readBotTriggerState } = await import("@/lib/db/bot-installations")

    await runBotDelivery({
      delivery,
      resolved,
      now,
      executors: { handler: async () => ({ output: { edgeValue: true } }) },
    })

    expect(await readBotTriggerState("boti_1", "opened")).toMatchObject({ lastEdgeValue: true })
  })

  it("writes no trigger state for a trigger that is not timed", async () => {
    const { delivery, resolved } = await seed()
    const { readBotTriggerState } = await import("@/lib/db/bot-installations")

    await runBotDelivery({
      delivery,
      resolved,
      now,
      executors: { handler: async () => ({ output: { cursor: "page-3" } }) },
    })

    // A manual or event trigger has no cursor to carry, and inventing one
    // would make an unrelated output look like scheduler state.
    expect(await readBotTriggerState("boti_1", "opened")).toBeUndefined()
  })

  it("cancelLiveBotRun reports whether the run was running here", async () => {
    expect(cancelLiveBotRun("run_bot_nope")).toBe(false)
  })
})

/**
 * A parked run has not settled. Treating it as a failure would spend an
 * attempt on somebody's thinking time, and closing the journal would leave the
 * resumption unable to write to it.
 */
describe("runBotDelivery when a handler parks", () => {
  it("does not journal a waiting transition after its delivery lease expires", async () => {
    const { delivery, resolved } = await seed()
    const outcome = await runBotDelivery({
      delivery,
      resolved,
      now,
      executors: {
        handler: async (ctx) => {
          await getDb().botEventDeliveries.update(delivery.id, { leaseExpiresAt: NOW })
          throw new BotRunParkedError(ctx.runId, "publish", NOW + 20_000)
        },
      },
    })

    expect(outcome.status).toBe("cancelled")
    expect((await runEventJournal.replay(outcome.runId)).map((event) => event.type)).not.toContain(
      "run.waiting"
    )
    expect((await getExecutionRun(outcome.runId))?.latestSnapshot?.allowedActions).not.toContain(
      "approve"
    )
  })

  it("keeps the same publication approval actionable after repeated re-entry", async () => {
    const { delivery, resolved } = await seed()
    const detail = { snapshot: { id: "snapshot-1", diff: "approved contents" } }
    const handler = jest.fn(async (ctx: BotExecutorContext) => {
      await ctx.step.waitForApproval("publish", {
        title: "Publish the prepared changes?",
        timeoutMs: 7 * 24 * 60 * 60 * 1_000,
        detail,
      })
    })
    let interruptId: string | undefined

    for (let attempt = 0; attempt < 3; attempt++) {
      // A fixed clock also verifies that occurrence identity is independent
      // of wall-clock precision. Re-entry must not re-create the approval.
      const outcome = await runBotDelivery({
        delivery,
        resolved,
        now,
        stepDeps: { now },
        executors: { handler },
      })
      expect(outcome.status).toBe("parked")
      const run = await getExecutionRun(outcome.runId)
      expect(run?.status).toBe("waiting")
      expect(run?.latestSnapshot?.status).toBe("waiting")
      expect(run?.latestSnapshot?.allowedActions).toEqual([
        "approve",
        "deny",
        "stop",
        "open_details",
      ])
      interruptId ??= run?.latestSnapshot?.pendingInterrupt?.id
      expect(run?.latestSnapshot?.pendingInterrupt?.id).toBe(interruptId)
      expect(await getDb().executionRunInterrupts.count()).toBe(1)
      expect(await getDb().executionRunInterrupts.get(interruptId!)).toMatchObject({
        status: "pending",
        approvalDetail: detail,
        expiresAt: NOW + 7 * 24 * 60 * 60 * 1_000,
      })
      expect((await getDb().botEventDeliveries.get(delivery.id))?.attempts).toBe(0)
    }

    const events = await runEventJournal.replay(botRunId(delivery.id))
    expect(events.filter((event) => event.type === "run.waiting")).toHaveLength(3)
    expect(events.filter((event) => event.type === "interrupt.requested")).toHaveLength(1)

    // Stopping the recovered run must invalidate this same approval, rather
    // than leave a newly actionable publication behind after cancellation.
    expect(await cancelBotRun(botRunId(delivery.id))).toBe(true)
    const cancelled = await getExecutionRun(botRunId(delivery.id))
    expect(cancelled?.latestSnapshot?.status).toBe("cancelled")
    expect(cancelled?.latestSnapshot?.pendingInterrupt).toBeUndefined()
    expect(cancelled?.latestSnapshot?.allowedActions).not.toContain("approve")
    expect((await getDb().executionRunInterrupts.get(interruptId!))?.status).toBe("expired")
  })

  it("reports parked, leaves the run open, and sets the delivery aside", async () => {
    const { delivery, resolved } = await seed()
    const executor = jest.fn(() => {
      throw new BotRunParkedError(botRunId(delivery.id), "send", NOW + 20_000, "interrupt-1")
    })

    const outcome = await runBotDelivery({
      delivery,
      resolved,
      now,
      executors: { handler: executor },
    })

    expect(outcome).toEqual({
      status: "parked",
      runId: botRunId(delivery.id),
      resumeAt: NOW + 20_000,
      waitingFor: "interrupt-1",
    })

    const run = await getExecutionRun(botRunId(delivery.id))
    expect(run?.status).toBe("waiting")
    // Never ended: the resumption still has to journal into it.
    expect(run?.endedAt).toBeUndefined()

    const [row] = await listBotDeliveries({ installationId: "boti_1" })
    expect(row).toMatchObject({
      status: "parked",
      nextAttemptAt: NOW + 20_000,
      waitingFor: "interrupt-1",
      attempts: 0,
    })
  })

  it("journals that it is waiting, so the card says so", async () => {
    const { delivery, resolved } = await seed()
    await runBotDelivery({
      delivery,
      resolved,
      now,
      executors: {
        handler: () => {
          throw new BotRunParkedError(botRunId(delivery.id), "send", NOW + 20_000)
        },
      },
    })

    const events = await runEventJournal.replay(botRunId(delivery.id))
    expect(events.map((event) => event.type)).toContain("run.waiting")
  })
})

it("persists the original policy ceiling before dispatch and never widens it on resumed runs", async () => {
  const { delivery, resolved } = await seed()
  resolved.policy = { requireApprovalForWrites: true, maxAutonomy: "confirm" }
  const handler = async () => {
    throw new BotRunParkedError(botRunId(delivery.id), "wait", NOW + 100)
  }
  await runBotDelivery({ delivery, resolved, now, executors: { handler } })
  expect((await getBotRunStep(botRunId(delivery.id), "__host:policy"))?.output).toEqual(
    resolved.policy
  )
  resolved.policy = { requireApprovalForWrites: false, maxAutonomy: "autopilot" }
  await runBotDelivery({ delivery, resolved, now, executors: { handler } })
  expect((await getBotRunStep(botRunId(delivery.id), "__host:policy"))?.output).toEqual({
    requireApprovalForWrites: true,
    maxAutonomy: "confirm",
  })
})
