/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import {
  claimBotDelivery,
  enqueueBotDelivery,
  markBotDeliveryRunning,
} from "@/lib/db/bot-event-deliveries"
import { installBot, updateBotInstallation } from "@/lib/db/bot-installations"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { __resetBotsForTesting, registerBot } from "@/lib/plugin/registries/bot-registry"
import type { BotEventEnvelopeV1 } from "@/types/bot/event"
import type { PluginBotDef } from "@/types/plugin/plugin-bot"

import { drainBotDeliveries, startBotDeliveryRunner } from "./delivery-runner"
import { __resetLiveBotRunsForTesting } from "./run"

const NOW = 1_700_000_000_000
const now = () => NOW

function envelope(overrides: Partial<BotEventEnvelopeV1> = {}): BotEventEnvelopeV1 {
  return {
    eventId: "bev_1",
    deliveryId: "bdl_1",
    source: "integration",
    type: "pull_request.opened",
    installationId: "boti_1",
    triggerId: "opened",
    occurredAt: NOW,
    receivedAt: NOW,
    payload: {},
    provenance: { selfProduced: false, depth: 0 },
    ...overrides,
  }
}

async function seedInstallation(handler = jest.fn()) {
  const definition: PluginBotDef = {
    id: "digest",
    name: "Digest",
    version: "1.0.0",
    executor: "handler",
    triggers: [{ id: "opened", kind: "manual" }],
  } as PluginBotDef
  registerBot("digest", { id: "acme:digest", definition, handler }, { pluginId: "acme" })
  return installBot({
    id: "boti_1",
    definitionId: "acme:digest",
    definitionSource: "plugin",
    pinnedVersion: "1.0.0",
    scope: { kind: "account" },
    now: NOW,
  })
}

beforeEach(async () => {
  __resetDbForTesting()
  __resetBotsForTesting()
  __resetLiveBotRunsForTesting()
  const db = getDb()
  await db.botInstallations.clear()
  await db.botEventDeliveries.clear()
  await db.botRunSteps.clear()
  await db.executionRuns.clear()
  await db.executionRunEvents.clear()
  await db.projects.clear()
}, 15_000)

describe("drainBotDeliveries", () => {
  it("cancels an owned claim if host shutdown happens during workspace resolution", async () => {
    const handler = jest.fn()
    await seedInstallation(handler)
    await enqueueBotDelivery({ envelope: envelope(), now: NOW })
    const controller = new AbortController()
    const result = await drainBotDeliveries({
      owner: "host",
      signal: controller.signal,
      resolveCwd: () => {
        controller.abort()
        return undefined
      },
    })
    expect(result[0].outcome.status).toBe("cancelled")
    expect(handler).not.toHaveBeenCalled()
    expect((await getDb().botEventDeliveries.get("bdl_1"))?.status).toBe("dismissed")
  })

  it("lets only one overlapping pass execute the same delivery", async () => {
    const handler = jest.fn()
    await seedInstallation(handler)
    await enqueueBotDelivery({ envelope: envelope(), now: NOW })
    const results = await Promise.all([
      drainBotDeliveries({ owner: "host-a", now, organizationPolicy: {} }),
      drainBotDeliveries({ owner: "host-b", now }),
    ])
    expect(handler).toHaveBeenCalledTimes(1)
    expect(results.flat().filter((item) => item.outcome.status === "completed")).toHaveLength(1)
  })

  it.each(["disabled", "lease-lost"] as const)(
    "renews a long execution, then aborts it when %s",
    async (reason) => {
      let started!: () => void
      const ready = new Promise<void>((resolve) => {
        started = resolve
      })
      await seedInstallation(
        jest.fn(
          (ctx) =>
            new Promise((resolve) => {
              ctx.signal.addEventListener("abort", () => resolve({ summary: "stopped" }), {
                once: true,
              })
              started()
            })
        )
      )
      await enqueueBotDelivery({ envelope: envelope(), now: NOW })
      jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick", "queueMicrotask"] })
      let clock = NOW
      try {
        const pass = drainBotDeliveries({ owner: "host", now: () => clock })
        await ready
        clock += 30_000
        await jest.advanceTimersByTimeAsync(30_000)
        expect((await getDb().botEventDeliveries.get("bdl_1"))?.leaseExpiresAt).toBe(
          clock + 120_000
        )
        if (reason === "disabled")
          await getDb().botInstallations.update("boti_1", { status: "disabled" })
        else await getDb().botEventDeliveries.update("bdl_1", { leaseOwner: "another-host" })
        clock += 30_000
        await jest.advanceTimersByTimeAsync(30_000)
        expect((await pass)[0].outcome.status).toBe("cancelled")
        if (reason === "lease-lost") {
          expect(await getDb().botEventDeliveries.get("bdl_1")).toMatchObject({
            leaseOwner: "another-host",
            status: "running",
          })
        }
      } finally {
        jest.useRealTimers()
      }
    }
  )

  it("continues monitoring behind a full batch of work blocked by a repository lease", async () => {
    const handler = jest.fn()
    await seedInstallation(handler)
    for (let index = 0; index < 8; index++) {
      await enqueueBotDelivery({
        envelope: envelope({ eventId: `event-${index}`, deliveryId: `delivery-${index}` }),
        concurrencyKey: "repo",
        now: NOW - 10 + index,
      })
    }
    await claimBotDelivery("delivery-0", "busy-host", NOW)
    await enqueueBotDelivery({
      envelope: envelope({ eventId: "poll", deliveryId: "poll" }),
      concurrencyKey: "monitor",
      now: NOW,
    })
    const attempts = await drainBotDeliveries({ owner: "host", now, batch: 5 })
    expect(attempts).toEqual([
      expect.objectContaining({
        deliveryId: "poll",
        outcome: { status: "completed", runId: "run_bot_poll" },
      }),
    ])
    expect(handler).toHaveBeenCalledTimes(1)
    expect((await getDb().botEventDeliveries.get("delivery-1"))?.status).toBe("pending")
  })
  it("allows other isolated work while approval is parked without concurrent execution", async () => {
    const { parkBotDelivery } = await import("@/lib/db/bot-event-deliveries")
    await seedInstallation()
    await enqueueBotDelivery({
      envelope: envelope(),
      concurrencyKey: "repo",
      holdConcurrencyWhileWaiting: false,
      now: NOW,
    })
    await parkBotDelivery("bdl_1", NOW + 1000, "approval", NOW)
    await enqueueBotDelivery({
      envelope: envelope({ eventId: "bev_2", deliveryId: "bdl_2" }),
      concurrencyKey: "repo",
      holdConcurrencyWhileWaiting: false,
      now: NOW,
    })
    const attempts = await drainBotDeliveries({ owner: "host", now })
    expect(attempts[0].deliveryId).toBe("bdl_2")
    expect(attempts[0].outcome.status).toBe("completed")
    expect((await getDb().botEventDeliveries.get("bdl_1"))?.status).toBe("parked")
  })
  it("resumes its own parked concurrency key without self-deadlocking", async () => {
    const { parkBotDelivery } = await import("@/lib/db/bot-event-deliveries")
    const handler = jest.fn().mockResolvedValue({ summary: "approved" })
    await seedInstallation(handler)
    await enqueueBotDelivery({ envelope: envelope(), concurrencyKey: "repo", now: NOW })
    await parkBotDelivery("bdl_1", NOW, "approval", NOW)
    expect((await drainBotDeliveries({ owner: "host", now }))[0].outcome.status).toBe("completed")
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it("atomically fences same-key claims from competing hosts", async () => {
    await seedInstallation()
    await enqueueBotDelivery({ envelope: envelope(), concurrencyKey: "repo", now: NOW })
    await enqueueBotDelivery({
      envelope: envelope({ eventId: "bev_2", deliveryId: "bdl_2" }),
      concurrencyKey: "repo",
      now: NOW,
    })
    const claims = await Promise.all([
      claimBotDelivery("bdl_1", "one", NOW),
      claimBotDelivery("bdl_2", "two", NOW),
    ])
    expect(claims.filter(Boolean)).toHaveLength(1)
  })
  it("does nothing when nothing is due", async () => {
    expect(await drainBotDeliveries({ owner: "host-a", now })).toEqual([])
  })

  it("runs a due delivery and reports the outcome", async () => {
    const handler = jest.fn().mockResolvedValue({ summary: "done" })
    await seedInstallation(handler)
    await enqueueBotDelivery({ envelope: envelope(), now: NOW })

    const attempts = await drainBotDeliveries({ owner: "host-a", now })

    expect(attempts).toHaveLength(1)
    expect(attempts[0].outcome.status).toBe("completed")
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it("skips a delivery another runner already holds", async () => {
    await seedInstallation()
    await enqueueBotDelivery({ envelope: envelope(), now: NOW })
    await claimBotDelivery("bdl_1", "host-b", NOW)

    const attempts = await drainBotDeliveries({ owner: "host-a", now })
    expect(attempts).toEqual([])
  })

  it("dismisses a delivery whose installation is gone", async () => {
    await seedInstallation()
    await enqueueBotDelivery({ envelope: envelope(), now: NOW })
    await getDb().botInstallations.delete("boti_1")

    const attempts = await drainBotDeliveries({ owner: "host-a", now })
    expect(attempts[0].outcome).toEqual({ status: "skipped", reason: "not_runnable" })
    expect((await getDb().botEventDeliveries.get("bdl_1"))?.status).toBe("dismissed")
  })

  it("dismisses rather than retries when the installation is disabled", async () => {
    await seedInstallation()
    await enqueueBotDelivery({ envelope: envelope(), now: NOW })
    await updateBotInstallation("boti_1", { status: "disabled" })

    // Waiting will not make a disabled installation runnable.
    const attempts = await drainBotDeliveries({ owner: "host-a", now })
    expect(attempts[0].outcome).toEqual({ status: "skipped", reason: "not_runnable" })
  })

  it("serialises deliveries that share a concurrency key", async () => {
    const handler = jest.fn()
    await seedInstallation(handler)
    await enqueueBotDelivery({
      envelope: envelope(),
      concurrencyKey: "repo#1",
      now: NOW,
    })
    await enqueueBotDelivery({
      envelope: envelope({ eventId: "bev_2", deliveryId: "bdl_2" }),
      concurrencyKey: "repo#1",
      now: NOW,
    })
    // Something else is already in flight on that key.
    await claimBotDelivery("bdl_1", "host-b", NOW)
    await markBotDeliveryRunning("bdl_1", "run_x", NOW)

    const attempts = await drainBotDeliveries({ owner: "host-a", now })
    expect(attempts).toEqual([])
    expect(handler).not.toHaveBeenCalled()
  })

  it("runs deliveries with different concurrency keys in the same pass", async () => {
    const handler = jest.fn()
    await seedInstallation(handler)
    await enqueueBotDelivery({ envelope: envelope(), concurrencyKey: "repo#1", now: NOW })
    await enqueueBotDelivery({
      envelope: envelope({ eventId: "bev_2", deliveryId: "bdl_2" }),
      concurrencyKey: "repo#2",
      now: NOW,
    })

    await drainBotDeliveries({ owner: "host-a", now })
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it("recovers an abandoned attempt instead of re-running it in the same pass", async () => {
    const handler = jest.fn()
    await seedInstallation(handler)
    await enqueueBotDelivery({ envelope: envelope(), now: NOW })
    await claimBotDelivery("bdl_1", "runner-a", NOW)
    await markBotDeliveryRunning("bdl_1", "run_bot_bdl_1", NOW)

    const later = NOW + 5 * 60_000
    const attempts = await drainBotDeliveries({ owner: "runner-b", now: () => later })

    expect(attempts).toEqual([
      { deliveryId: "bdl_1", outcome: { status: "skipped", reason: "recovered" } },
    ])
    // The point of the backoff: the row comes back on a later pass, not this one.
    expect(handler).not.toHaveBeenCalled()
    const row = await getDb().botEventDeliveries.get("bdl_1")
    expect(row?.status).toBe("pending")
    expect(row?.attempts).toBe(1)
  })

  it("does not let a Bot waiting on a human hold up the others", async () => {
    // The whole point of parking. `drainBotDeliveries` walks its batch, so an
    // in-place poll used to stall every other Bot until the approval expired.
    const { BotRunParkedError } = await import("./step")
    await seedInstallation(
      jest.fn(() => {
        throw new BotRunParkedError("run_bot_bdl_1", "send", NOW + 20_000, "interrupt-1")
      })
    )
    const second = jest.fn()
    registerBot(
      "other",
      {
        id: "acme:other",
        definition: {
          id: "other",
          name: "Other",
          version: "1.0.0",
          executor: "handler",
          triggers: [{ id: "opened", kind: "manual" }],
        } as PluginBotDef,
        handler: second,
      },
      { pluginId: "acme" }
    )
    await installBot({
      id: "boti_2",
      definitionId: "acme:other",
      definitionSource: "plugin",
      pinnedVersion: "1.0.0",
      scope: { kind: "account" },
      now: NOW,
    })
    await enqueueBotDelivery({ envelope: envelope(), now: NOW })
    await enqueueBotDelivery({
      envelope: envelope({ eventId: "bev_2", deliveryId: "bdl_2", installationId: "boti_2" }),
      now: NOW,
    })

    const attempts = await drainBotDeliveries({ owner: "host-a", now })

    expect(attempts.find((a) => a.deliveryId === "bdl_1")?.outcome).toMatchObject({
      status: "parked",
    })
    expect(second).toHaveBeenCalled()
  })

  it("takes only one delivery per concurrency key in a pass", async () => {
    // The serialisation check reads the database BEFORE the claim, so two
    // siblings started together would both see nothing in flight.
    const handler = jest.fn()
    await seedInstallation(handler)
    await enqueueBotDelivery({ envelope: envelope(), concurrencyKey: "repo#1", now: NOW })
    await enqueueBotDelivery({
      envelope: envelope({ eventId: "bev_2", deliveryId: "bdl_2" }),
      concurrencyKey: "repo#1",
      now: NOW,
    })

    const attempts = await drainBotDeliveries({ owner: "host-a", now })

    expect(attempts).toHaveLength(1)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it("hands a correlated event to the run already waiting for it", async () => {
    const { parkBotDelivery } = await import("@/lib/db/bot-event-deliveries")
    const handler = jest.fn()
    await seedInstallation(handler)
    await enqueueBotDelivery({ envelope: envelope({ correlation: "boti_1::ci:42" }), now: NOW })
    await parkBotDelivery("bdl_1", NOW + 20_000, "boti_1::ci:42", NOW)
    await enqueueBotDelivery({
      envelope: envelope({
        eventId: "bev_2",
        deliveryId: "bdl_2",
        correlation: "boti_1::ci:42",
      }),
      now: NOW,
    })

    const attempts = await drainBotDeliveries({ owner: "host-a", now })

    expect(attempts.find((a) => a.deliveryId === "bdl_2")?.outcome).toEqual({
      status: "skipped",
      reason: "consumed_by_wait",
    })
    // The row survives, because the waiting run reads its envelope on re-entry.
    expect(await getDb().botEventDeliveries.get("bdl_2")).toBeDefined()
    expect(handler).not.toHaveBeenCalled()
  })

  it("bounds one pass, so one Bot cannot starve the others", async () => {
    await seedInstallation()
    for (let i = 0; i < 4; i++) {
      await enqueueBotDelivery({
        envelope: envelope({ eventId: `bev_${i}`, deliveryId: `bdl_${i}` }),
        now: NOW,
      })
    }

    expect(await drainBotDeliveries({ owner: "host-a", batch: 2, now })).toHaveLength(2)
  })

  it("hands the run the directory the caller resolved", async () => {
    const handler = jest.fn()
    await seedInstallation(handler)
    await enqueueBotDelivery({ envelope: envelope(), now: NOW })

    await drainBotDeliveries({
      owner: "host-a",
      now,
      resolveCwd: () => "/repo",
    })
    expect(handler.mock.calls[0][0].cwd).toBe("/repo")
  })

  it("resolves a directory itself when the caller supplies none", async () => {
    // The bug this pins: both production call sites omitted `resolveCwd`, so
    // every agent-turn Bot refused before it started.
    const handler = jest.fn()
    await seedInstallation(handler)
    await updateBotInstallation("boti_1", {
      scope: { kind: "workspace", workspaceId: "proj_1" },
      now: NOW,
    })
    await getDb().projects.add({
      id: "proj_1",
      name: "Web",
      roots: [{ path: "/repos/web", isPrimary: true }],
      createdAt: NOW,
      updatedAt: NOW,
    } as never)
    await enqueueBotDelivery({ envelope: envelope(), now: NOW })

    await drainBotDeliveries({ owner: "host-a", now })

    expect(handler.mock.calls[0][0].cwd).toBe("/repos/web")
  })
})

describe("startBotDeliveryRunner", () => {
  it("bounds overlapping passes and aborts an active handler on shutdown", async () => {
    let started!: () => void
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    const handler = jest.fn(
      (ctx) =>
        new Promise((resolve) => {
          ctx.signal.addEventListener("abort", () => resolve({ summary: "stopped" }), {
            once: true,
          })
          started()
        })
    )
    await seedInstallation(handler)
    await enqueueBotDelivery({ envelope: envelope(), now: NOW })
    await enqueueBotDelivery({
      envelope: envelope({ eventId: "second", deliveryId: "second" }),
      now: NOW,
    })
    jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick", "queueMicrotask"] })
    const handle = startBotDeliveryRunner({ owner: "host", intervalMs: 5, batch: 1, now })
    try {
      await jest.advanceTimersByTimeAsync(5)
      await ready
      await jest.advanceTimersByTimeAsync(20)
      expect(handler).toHaveBeenCalledTimes(1)
      handle.stop()
      await jest.advanceTimersByTimeAsync(20)
      expect(handler.mock.calls[0][0].signal.aborted).toBe(true)
      expect(handler).toHaveBeenCalledTimes(1)
    } finally {
      handle.stop()
      jest.useRealTimers()
    }
  })

  it("prunes settled deliveries hourly and survives a failed prune", async () => {
    jest.useFakeTimers()
    let clock = NOW
    const prune = jest
      .spyOn(getDb().botEventDeliveries, "bulkDelete")
      .mockRejectedValueOnce(new Error("temporary storage failure"))
    await enqueueBotDelivery({ envelope: envelope(), now: NOW - 30 * 24 * 60 * 60_000 })
    await getDb().botEventDeliveries.update("bdl_1", {
      status: "succeeded",
      updatedAt: NOW - 30 * 24 * 60 * 60_000,
      settledAt: NOW - 30 * 24 * 60 * 60_000,
    })
    const handle = startBotDeliveryRunner({ owner: "host", intervalMs: 5, now: () => clock })
    try {
      clock += 60 * 60_000
      await jest.advanceTimersByTimeAsync(5)
      expect(prune).toHaveBeenCalledTimes(1)
      clock += 60 * 60_000
      await jest.advanceTimersByTimeAsync(5)
      expect(prune).toHaveBeenCalledTimes(2)
    } finally {
      handle.stop()
      prune.mockRestore()
      jest.useRealTimers()
    }
  })

  it("stops cleanly and idempotently", () => {
    const handle = startBotDeliveryRunner({ owner: "host-a", intervalMs: 10_000, now })
    handle.stop()
    expect(() => handle.stop()).not.toThrow()
  })

  it("keeps looping after a pass throws", async () => {
    // A dead runner is a queue that silently stops draining, so a thrown pass
    // must not kill the loop.
    jest.useFakeTimers()
    const failing = jest
      .spyOn(getDb().botEventDeliveries, "toArray")
      .mockRejectedValueOnce(new Error("transient"))

    const handle = startBotDeliveryRunner({ owner: "host-a", intervalMs: 5, now })
    await jest.advanceTimersByTimeAsync(20)
    expect(failing).toHaveBeenCalled()
    handle.stop()
    jest.useRealTimers()
    failing.mockRestore()
  })
})
