/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import type { BotEventEnvelopeV1 } from "@/types/bot/event"

import {
  BOT_DELIVERY_LEASE_MS,
  BOT_DELIVERY_RETENTION_MS,
  botDeliveryDedupKey,
  claimBotDelivery,
  completeBotDelivery,
  countActiveBotDeliveriesForKey,
  dismissBotDelivery,
  enqueueBotDelivery,
  failBotDelivery,
  findBotDeliveryByCorrelation,
  isTerminalBotDelivery,
  listBotDeliveries,
  listDueBotDeliveries,
  markBotDeliveryRunning,
  pruneSettledBotDeliveries,
  recoverAbandonedBotDelivery,
  recoverStaleBotDeliveries,
  renewBotDeliveryLease,
  replayBotDelivery,
} from "./bot-event-deliveries"
import { __resetDbForTesting, getDb } from "./schema"

const NOW = 1_700_000_000_000

function envelope(overrides: Partial<BotEventEnvelopeV1> = {}): BotEventEnvelopeV1 {
  return {
    eventId: "evt_1",
    deliveryId: "del_1",
    source: "integration",
    type: "pull_request.opened",
    installationId: "boti_1",
    triggerId: "opened",
    occurredAt: NOW,
    receivedAt: NOW,
    payload: { number: 42 },
    provenance: { selfProduced: false, depth: 0 },
    ...overrides,
  }
}

describe("botDeliveryDedupKey", () => {
  it("scopes the key to the installation, not the event", () => {
    // The same event legitimately fans out to several installations, and a
    // global key would let the first recipient swallow everyone else's copy.
    expect(botDeliveryDedupKey("boti_1", "evt_1")).not.toBe(botDeliveryDedupKey("boti_2", "evt_1"))
  })
})

describe("isTerminalBotDelivery", () => {
  it("counts dismissed as finished and failed as not", () => {
    expect(isTerminalBotDelivery("succeeded")).toBe(true)
    expect(isTerminalBotDelivery("deadletter")).toBe(true)
    expect(isTerminalBotDelivery("dismissed")).toBe(true)
    // `failed` is a retry state, so a runner may still pick it up.
    expect(isTerminalBotDelivery("failed")).toBe(false)
    expect(isTerminalBotDelivery("pending")).toBe(false)
  })
})

describe("botEventDeliveries", () => {
  beforeEach(async () => {
    __resetDbForTesting()
    await getDb().botEventDeliveries.clear()
  }, 15_000)

  it("enqueues a pending delivery carrying its whole envelope", async () => {
    const row = await enqueueBotDelivery({ envelope: envelope(), now: NOW })

    expect(row.id).toBe("del_1")
    expect(row.status).toBe("pending")
    expect(row.attempts).toBe(0)
    expect(row.nextAttemptAt).toBe(NOW)
    // The envelope rides along so the delivery is independently replayable.
    expect(row.envelope.payload).toEqual({ number: 42 })
  })

  it("is enqueue-once for the same event and installation", async () => {
    const first = await enqueueBotDelivery({ envelope: envelope(), now: NOW })
    const second = await enqueueBotDelivery({
      envelope: envelope({ deliveryId: "del_2" }),
      now: NOW + 1,
    })

    expect(second.id).toBe(first.id)
    expect(await getDb().botEventDeliveries.count()).toBe(1)
  })

  it("fans the same event out to two installations", async () => {
    await enqueueBotDelivery({ envelope: envelope(), now: NOW })
    await enqueueBotDelivery({
      envelope: envelope({ deliveryId: "del_2", installationId: "boti_2" }),
      now: NOW,
    })

    expect(await getDb().botEventDeliveries.count()).toBe(2)
  })

  it("holds a debounced delivery until its notBefore", async () => {
    const row = await enqueueBotDelivery({
      envelope: envelope(),
      notBefore: NOW + 5_000,
      now: NOW,
    })

    expect(row.nextAttemptAt).toBe(NOW + 5_000)
    expect(await listDueBotDeliveries(10, NOW)).toEqual([])
    expect((await listDueBotDeliveries(10, NOW + 5_000)).map((r) => r.id)).toEqual(["del_1"])
  })

  it("claims a due delivery and refuses a second claimant while the lease lives", async () => {
    await enqueueBotDelivery({ envelope: envelope(), now: NOW })

    const claimed = await claimBotDelivery("del_1", "runner-a", NOW)
    expect(claimed?.leaseOwner).toBe("runner-a")
    expect(claimed?.leaseExpiresAt).toBe(NOW + BOT_DELIVERY_LEASE_MS)

    expect(await claimBotDelivery("del_1", "runner-b", NOW + 1)).toBeUndefined()
  })

  it("lets the same owner re-claim, so a retrying runner is not locked out", async () => {
    await enqueueBotDelivery({ envelope: envelope(), now: NOW })
    await claimBotDelivery("del_1", "runner-a", NOW)
    expect(await claimBotDelivery("del_1", "runner-a", NOW + 1)).toBeDefined()
  })

  it("treats an expired lease as due again", async () => {
    await enqueueBotDelivery({ envelope: envelope(), now: NOW })
    await claimBotDelivery("del_1", "runner-a", NOW)

    const after = NOW + BOT_DELIVERY_LEASE_MS + 1
    // The runner that held it is gone. Leaving it leased forever is the
    // difference between a crash costing one retry and costing the event.
    expect((await listDueBotDeliveries(10, after)).map((r) => r.id)).toEqual(["del_1"])
    expect(await claimBotDelivery("del_1", "runner-b", after)).toBeDefined()
  })

  it("renews only for the owner that holds the lease", async () => {
    await enqueueBotDelivery({ envelope: envelope(), now: NOW })
    await claimBotDelivery("del_1", "runner-a", NOW)

    expect(await renewBotDeliveryLease("del_1", "runner-b", NOW + 1)).toBe(false)
    expect(await renewBotDeliveryLease("del_1", "runner-a", NOW + 1)).toBe(true)
  })

  it("attaches the run it started, then settles and clears the lease", async () => {
    await enqueueBotDelivery({ envelope: envelope(), now: NOW })
    await claimBotDelivery("del_1", "runner-a", NOW)
    await markBotDeliveryRunning("del_1", "run_9", NOW + 1)
    await completeBotDelivery("del_1", NOW + 2)

    const row = await getDb().botEventDeliveries.get("del_1")
    expect(row?.status).toBe("succeeded")
    expect(row?.runId).toBe("run_9")
    expect(row?.settledAt).toBe(NOW + 2)
    expect("leaseOwner" in (row ?? {})).toBe(false)
  })

  it("backs off a retryable failure and keeps the delivery pending", async () => {
    await enqueueBotDelivery({ envelope: envelope(), now: NOW })
    const next = await failBotDelivery("del_1", new Error("upstream 500"), NOW, () => 0)

    expect(next?.status).toBe("pending")
    expect(next?.attempts).toBe(1)
    expect(next?.nextAttemptAt).toBeGreaterThan(NOW)
    expect(next?.lastError).toContain("upstream 500")
  })

  it("dead-letters an error that will always fail, rather than burning attempts", async () => {
    await enqueueBotDelivery({ envelope: envelope(), now: NOW })
    const next = await failBotDelivery("del_1", new Error("403 forbidden"), NOW)

    expect(next?.status).toBe("deadletter")
    expect(next?.settledAt).toBe(NOW)
  })

  it("dead-letters once the attempt budget is spent", async () => {
    await enqueueBotDelivery({ envelope: envelope(), now: NOW })
    let last
    for (let i = 0; i < 5; i++) {
      last = await failBotDelivery("del_1", new Error("upstream 500"), NOW, () => 0)
    }
    expect(last?.status).toBe("deadletter")
  })

  it("keeps a dismissal apart from a failure", async () => {
    await enqueueBotDelivery({ envelope: envelope(), now: NOW })
    await dismissBotDelivery("del_1", "superseded by a later edit", NOW + 1)

    const row = await getDb().botEventDeliveries.get("del_1")
    // A coalesced burst is not a broken queue.
    expect(row?.status).toBe("dismissed")
    expect(row?.lastError).toBe("superseded by a later edit")
  })

  it("replays a dead letter back to a clean pending row", async () => {
    await enqueueBotDelivery({ envelope: envelope(), now: NOW })
    await failBotDelivery("del_1", new Error("403 forbidden"), NOW)

    const replayed = await replayBotDelivery("del_1", NOW + 10)
    expect(replayed?.status).toBe("pending")
    expect(replayed?.attempts).toBe(0)
    expect("settledAt" in (replayed ?? {})).toBe(false)
    expect("lastError" in (replayed ?? {})).toBe(false)
  })

  it("counts only genuinely in-flight deliveries for a concurrency key", async () => {
    await enqueueBotDelivery({ envelope: envelope(), concurrencyKey: "repo#1", now: NOW })
    await enqueueBotDelivery({
      envelope: envelope({ eventId: "evt_2", deliveryId: "del_2" }),
      concurrencyKey: "repo#1",
      now: NOW,
    })

    expect(await countActiveBotDeliveriesForKey("repo#1", NOW)).toBe(0)

    await claimBotDelivery("del_1", "runner-a", NOW)
    expect(await countActiveBotDeliveriesForKey("repo#1", NOW)).toBe(1)

    // An expired lease is not in flight, or one crashed runner would block the
    // key forever.
    expect(await countActiveBotDeliveriesForKey("repo#1", NOW + BOT_DELIVERY_LEASE_MS + 1)).toBe(0)
  })

  it("finds a delivery by the correlation key a parked run waits on", async () => {
    await enqueueBotDelivery({ envelope: envelope({ correlation: "ci:run-42" }), now: NOW })
    expect((await findBotDeliveryByCorrelation("ci:run-42"))?.id).toBe("del_1")
    expect(await findBotDeliveryByCorrelation("ci:run-43")).toBeUndefined()
  })

  it("lists by installation and status, newest first", async () => {
    await enqueueBotDelivery({ envelope: envelope(), now: NOW })
    await enqueueBotDelivery({
      envelope: envelope({ eventId: "evt_2", deliveryId: "del_2" }),
      now: NOW + 1,
    })
    await enqueueBotDelivery({
      envelope: envelope({ eventId: "evt_3", deliveryId: "del_3", installationId: "boti_2" }),
      now: NOW + 2,
    })

    expect((await listBotDeliveries({ installationId: "boti_1" })).map((r) => r.id)).toEqual([
      "del_2",
      "del_1",
    ])
    await completeBotDelivery("del_1", NOW + 3)
    expect((await listBotDeliveries({ status: "succeeded" })).map((r) => r.id)).toEqual(["del_1"])
  })

  it("prunes settled rows past the retention window and leaves live ones", async () => {
    await enqueueBotDelivery({ envelope: envelope(), now: NOW })
    await enqueueBotDelivery({
      envelope: envelope({ eventId: "evt_2", deliveryId: "del_2" }),
      now: NOW,
    })
    await completeBotDelivery("del_1", NOW)

    expect(await pruneSettledBotDeliveries(NOW + 1)).toBe(0)
    expect(await pruneSettledBotDeliveries(NOW + BOT_DELIVERY_RETENTION_MS + 1)).toBe(1)
    expect((await getDb().botEventDeliveries.toArray()).map((r) => r.id)).toEqual(["del_2"])
  })
})

/**
 * A host that stops mid-attempt used to leave the delivery `running` forever:
 * nothing listed it, nothing pruned it, and it counted against its own
 * concurrency key, so that key was retired along with it.
 */
describe("botEventDeliveries recovery after a host stops mid-attempt", () => {
  const AFTER_LEASE = NOW + BOT_DELIVERY_LEASE_MS + 1

  beforeEach(async () => {
    __resetDbForTesting()
    await getDb().botEventDeliveries.clear()
  }, 15_000)

  async function abandonedRunningDelivery(concurrencyKey?: string) {
    await enqueueBotDelivery({
      envelope: envelope(),
      now: NOW,
      ...(concurrencyKey ? { concurrencyKey } : {}),
    })
    await claimBotDelivery("del_1", "runner-a", NOW)
    await markBotDeliveryRunning("del_1", "run_bot_del_1", NOW)
  }

  it("makes a running delivery due again once its lease expires", async () => {
    await abandonedRunningDelivery()

    expect(await listDueBotDeliveries(10, NOW)).toEqual([])
    expect((await listDueBotDeliveries(10, AFTER_LEASE)).map((r) => r.id)).toEqual(["del_1"])
  })

  it("frees the concurrency key a crashed running delivery held", async () => {
    await abandonedRunningDelivery("repo#1")

    expect(await countActiveBotDeliveriesForKey("repo#1", NOW)).toBe(1)
    expect(await countActiveBotDeliveriesForKey("repo#1", AFTER_LEASE)).toBe(0)
  })

  it("charges one attempt and backs the delivery off rather than re-running it", async () => {
    await abandonedRunningDelivery()

    expect(await recoverAbandonedBotDelivery("del_1", AFTER_LEASE, () => 0)).toBe("recovered")

    const row = await getDb().botEventDeliveries.get("del_1")
    expect(row?.status).toBe("pending")
    expect(row?.attempts).toBe(1)
    expect(row?.nextAttemptAt).toBeGreaterThan(AFTER_LEASE)
    expect(row?.lastError).toContain("interrupted")
    expect("leaseOwner" in (row ?? {})).toBe(false)
  })

  it("leaves a delivery that is not abandoned alone", async () => {
    await abandonedRunningDelivery()
    expect(await recoverAbandonedBotDelivery("del_1", NOW)).toBeNull()
    expect((await getDb().botEventDeliveries.get("del_1"))?.status).toBe("running")
  })

  it("dead-letters a delivery that keeps killing whatever runs it", async () => {
    await enqueueBotDelivery({ envelope: envelope(), now: NOW })

    let outcome: string | null = null
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const at = NOW + (attempt + 1) * (BOT_DELIVERY_LEASE_MS + 1)
      await claimBotDelivery("del_1", "runner-a", at)
      await markBotDeliveryRunning("del_1", "run_bot_del_1", at)
      outcome = await recoverAbandonedBotDelivery("del_1", at + BOT_DELIVERY_LEASE_MS + 1, () => 0)
      if (outcome === "deadlettered") break
    }

    expect(outcome).toBe("deadlettered")
    const row = await getDb().botEventDeliveries.get("del_1")
    expect(row?.status).toBe("deadletter")
    expect(row?.settledAt).toBeDefined()
  })

  it("refuses a claim while another owner's lease on a running row is alive", async () => {
    await abandonedRunningDelivery()
    expect(await claimBotDelivery("del_1", "runner-b", NOW)).toBeUndefined()
    expect(await claimBotDelivery("del_1", "runner-b", AFTER_LEASE)).toBeDefined()
  })

  it("reclaims only this host's own rows at boot, before their leases expire", async () => {
    await enqueueBotDelivery({ envelope: envelope(), now: NOW })
    await enqueueBotDelivery({
      envelope: envelope({ eventId: "evt_2", deliveryId: "del_2" }),
      now: NOW,
    })
    await claimBotDelivery("del_1", "desktop:acct", NOW)
    await markBotDeliveryRunning("del_1", "run_bot_del_1", NOW)
    await claimBotDelivery("del_2", "brain:acct", NOW)

    expect(
      await recoverStaleBotDeliveries({ owner: "desktop:acct", now: NOW, random: () => 0 })
    ).toBe(1)

    expect((await getDb().botEventDeliveries.get("del_1"))?.status).toBe("pending")
    // A peer is still working on its own row; a blanket sweep would yank it.
    expect((await getDb().botEventDeliveries.get("del_2"))?.status).toBe("leased")
  })

  it("retires a delivery left unsettled for longer than the retention window", async () => {
    await enqueueBotDelivery({ envelope: envelope(), now: NOW })

    await pruneSettledBotDeliveries(NOW + BOT_DELIVERY_RETENTION_MS + 1)

    const row = await getDb().botEventDeliveries.get("del_1")
    expect(row?.status).toBe("dismissed")
    expect(row?.lastError).toContain("retention")
  })
})
