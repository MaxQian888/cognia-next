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

import { BotExecutorUnavailableError } from "./executors/types"
import { __resetLiveBotRunsForTesting, botRunId, cancelLiveBotRun, runBotDelivery } from "./run"

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
}, 15_000)

describe("botRunId", () => {
  it("is derived from the delivery, so a re-entry finds its own state", () => {
    expect(botRunId("bdl_1")).toBe(botRunId("bdl_1"))
    expect(botRunId("bdl_1")).not.toBe(botRunId("bdl_2"))
  })
})

describe("runBotDelivery", () => {
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
    expect((await getExecutionRun(botRunId(delivery.id)))?.status).toBe("failed")
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

  it("cancelLiveBotRun reports whether the run was running here", async () => {
    expect(cancelLiveBotRun("run_bot_nope")).toBe(false)
  })
})
