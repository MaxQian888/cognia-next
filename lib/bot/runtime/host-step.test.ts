/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import { enqueueBotDelivery } from "@/lib/db/bot-event-deliveries"
import { installBot } from "@/lib/db/bot-installations"
import type { BotEventDeliveryRow, BotInstallationRow } from "@/lib/db/bot-types"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import type { InstalledBot } from "@/lib/bot/installed-bot"
import type { BotEventEnvelopeV1 } from "@/types/bot/event"

import { BotRunParkedError } from "./step"
import { __resetLiveBotRunsForTesting, botRunId, runBotDelivery } from "./run"
import {
  clearPendingPark,
  createHostStepApi,
  pendingParks,
  recordPendingPark,
  requireLiveBotRunSignal,
  takePendingPark,
} from "./host-step"

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
    actor: { kind: "human", id: "octocat" },
  }
}

async function seed(): Promise<{ delivery: BotEventDeliveryRow; resolved: InstalledBot }> {
  const installation: BotInstallationRow = await installBot({
    id: "boti_1",
    definitionId: "acme:digest",
    definitionSource: "plugin",
    pinnedVersion: "1.0.0",
    scope: { kind: "account" },
    config: {},
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
      policyResolution: { policy: {}, provenance: {}, refusals: [] },
      problems: [],
    },
  }
}

beforeEach(async () => {
  __resetDbForTesting()
  __resetLiveBotRunsForTesting()
  pendingParks.clear()
  const db = getDb()
  await db.botInstallations.clear()
  await db.botEventDeliveries.clear()
  await db.botRunSteps.clear()
  await db.executionRuns.clear()
  await db.executionRunEvents.clear()
  await db.executionRunInterrupts.clear()
})

describe("pendingParks", () => {
  it("records, takes once, and clears by run id", () => {
    const error = new BotRunParkedError("run_1", "publish", NOW + 1000, "interrupt")
    recordPendingPark(error)
    expect(pendingParks.get("run_1")).toBe(error)

    expect(takePendingPark("run_1")).toBe(error)
    expect(takePendingPark("run_1")).toBeUndefined()

    recordPendingPark(error)
    clearPendingPark("run_1")
    expect(pendingParks.get("run_1")).toBeUndefined()
  })
})

describe("requireLiveBotRunSignal", () => {
  it("refuses a run that is not executing on this host", () => {
    expect(() => requireLiveBotRunSignal("run_nowhere")).toThrow(
      "Bot run is not executing on this host"
    )
  })

  it("returns the run's live signal while the delivery is running", async () => {
    const { delivery, resolved } = await seed()
    const runId = botRunId(delivery.id)
    let seen: AbortSignal | undefined
    await runBotDelivery({
      delivery,
      resolved,
      now,
      executors: {
        handler: async () => {
          seen = requireLiveBotRunSignal(runId)
        },
      },
    })
    expect(seen?.aborted).toBe(false)
    // Once the attempt settles, the run is no longer live here.
    expect(() => requireLiveBotRunSignal(runId)).toThrow("not executing on this host")
  })
})

describe("createHostStepApi", () => {
  it("parks an unanswered wait instead of blocking", async () => {
    const { delivery, resolved } = await seed()
    const runId = botRunId(delivery.id)
    let parked: unknown
    await runBotDelivery({
      delivery,
      resolved,
      now,
      stepDeps: { now },
      executors: {
        handler: async () => {
          const step = createHostStepApi({ runId, deps: { now } })
          try {
            await step.waitForApproval("publish", { title: "Publish?", timeoutMs: 60_000 })
          } catch (error) {
            parked = error
            return
          }
          parked = new Error("waitForApproval did not park")
        },
      },
    })
    expect(parked).toBeInstanceOf(BotRunParkedError)
    expect((parked as BotRunParkedError).stepName).toBe("publish")
  })

  it("shares the run's live signal, so cancellation reaches the host-call path", async () => {
    const { delivery, resolved } = await seed()
    const runId = botRunId(delivery.id)
    let parked: unknown
    await runBotDelivery({
      delivery,
      resolved,
      now,
      stepDeps: { now },
      executors: {
        handler: async () => {
          const step = createHostStepApi({ runId, deps: { now } })
          try {
            await step.waitForEvent("ci", { key: "missing", timeoutMs: 60_000 })
          } catch (error) {
            parked = error
          }
        },
      },
    })
    expect(parked).toBeInstanceOf(BotRunParkedError)
    expect((parked as BotRunParkedError).waitingFor).toBe("missing")
  })
})
