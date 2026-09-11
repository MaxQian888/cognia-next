/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"
import Dexie from "dexie"

import type { BotEventDeliveryRow } from "@/lib/db/bot-types"
import { listDueBotDeliveries } from "@/lib/db/bot-event-deliveries"
import { getDb, __resetDbForTesting } from "@/lib/db/schema"
import type { Transport } from "@/lib/tauri/transport-types"

import {
  MIRROR_BOT_DELIVERY_RETENTION_MS,
  applyBotDeliveryRows,
  normalizeMirroredDelivery,
  sweepAgedMirroredDeliveries,
  syncBotEventDeliveries,
} from "./bot-event-deliveries"

const NOW = 1_700_000_000_000

function makeTransport(rows: BotEventDeliveryRow[] = []): Transport {
  return {
    call: jest.fn(async () => ({
      rows,
      deleted_ids: [],
      next_since: 21,
    })) as unknown as Transport["call"],
    subscribe: jest.fn(() => () => {}) as unknown as Transport["subscribe"],
  }
}

function delivery(id: string, over: Partial<BotEventDeliveryRow> = {}): BotEventDeliveryRow {
  return {
    id,
    eventId: `evt_${id}`,
    dedupKey: `dedup_${id}`,
    installationId: "boti_1",
    triggerId: "cron",
    source: "integration",
    type: "pull_request.opened",
    status: "pending",
    attempts: 0,
    receivedAt: NOW,
    updatedAt: NOW,
    nextAttemptAt: 0,
    envelope: {
      installationId: "boti_1",
      triggerId: "cron",
      receivedAt: NOW,
      eventId: `evt_${id}`,
      deliveryId: id,
      source: "integration",
      type: "pull_request.opened",
      occurredAt: NOW,
      actor: { kind: "system" },
      provenance: { selfProduced: false, depth: 0 },
      payload: { body: "a whole pull request description" },
    } as BotEventDeliveryRow["envelope"],
    ...over,
  }
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
})

describe("normalizeMirroredDelivery", () => {
  it("marks the row mirrored whatever the Host sent", () => {
    // Two hosts running one delivery mint the SAME `ExecutionRun` id, because
    // the run id is derived from the delivery id. That is corruption, not
    // duplicated effort, so the flag cannot depend on the sender.
    const row = normalizeMirroredDelivery(delivery("bdl_1", { syncedFromHost: undefined }))
    expect(row.syncedFromHost).toBe(true)
  })

  it("strips the dedupe key, which is a UNIQUE index on the client", () => {
    const row = normalizeMirroredDelivery(
      delivery("bdl_1", { dedupKey: "boti_1::evt_1" } as Partial<BotEventDeliveryRow>)
    )
    expect("dedupKey" in row).toBe(false)
  })

  it("drops the Host's scheduling state", () => {
    const row = normalizeMirroredDelivery(
      delivery("bdl_1", {
        concurrencyKey: "boti_1::repo",
        leaseOwner: "darwin:acct",
        leaseExpiresAt: NOW + 60_000,
      })
    )
    expect("concurrencyKey" in row).toBe(false)
    expect("leaseOwner" in row).toBe(false)
    expect("leaseExpiresAt" in row).toBe(false)
  })
})

describe("applyBotDeliveryRows", () => {
  it("never lets a mirrored row become due locally", async () => {
    // `nextAttemptAt: 0` makes the row MORE due, so the fence is the flag, and
    // the fence lives in the queue module every claim path flows through.
    await applyBotDeliveryRows([delivery("bdl_1", { status: "pending" })], NOW)
    expect(await listDueBotDeliveries(10, NOW)).toEqual([])
  })

  it("stores the row so a console can render it", async () => {
    await applyBotDeliveryRows([delivery("bdl_1", { status: "deadletter" })], NOW)
    const stored = await getDb().botEventDeliveries.get("bdl_1")
    expect(stored).toMatchObject({ status: "deadletter", installationId: "boti_1" })
  })
})

describe("sweepAgedMirroredDeliveries", () => {
  it("ages out a settled mirrored row past the retention window", async () => {
    const old = NOW - MIRROR_BOT_DELIVERY_RETENTION_MS - 1
    await applyBotDeliveryRows([delivery("bdl_old", { status: "succeeded", receivedAt: old })], old)
    expect(await sweepAgedMirroredDeliveries(NOW)).toBe(1)
    expect(await getDb().botEventDeliveries.get("bdl_old")).toBeUndefined()
  })

  it("keeps an unsettled mirrored row however old it is", async () => {
    // A delivery still `failed` is one a person may yet replay on the Host.
    const old = NOW - MIRROR_BOT_DELIVERY_RETENTION_MS - 1
    await applyBotDeliveryRows([delivery("bdl_old", { status: "failed", receivedAt: old })], old)
    expect(await sweepAgedMirroredDeliveries(NOW)).toBe(0)
  })

  it("never touches a row this device owns", async () => {
    const old = NOW - MIRROR_BOT_DELIVERY_RETENTION_MS - 1
    await getDb().botEventDeliveries.put(
      delivery("bdl_mine", { status: "succeeded", receivedAt: old })
    )
    expect(await sweepAgedMirroredDeliveries(NOW)).toBe(0)
    expect(await getDb().botEventDeliveries.get("bdl_mine")).toBeDefined()
  })
})

describe("syncBotEventDeliveries", () => {
  it("pulls the table and mirrors the status projection", async () => {
    const tx = makeTransport([delivery("bdl_1", { status: "running" })])
    const out = await syncBotEventDeliveries(tx, { since: 0 })
    expect(tx.call).toHaveBeenCalledWith(
      "sync_pull",
      expect.objectContaining({ table: "botEventDeliveries", since: 0 })
    )
    expect(out.ok).toBe(true)
    expect((await getDb().botEventDeliveries.get("bdl_1"))?.syncedFromHost).toBe(true)
  })
})

it("cancels before looking up the sweep table after an awaited apply", async () => {
  const table = getDb().botEventDeliveries
  let current = true
  const read = jest.spyOn(table, "where")
  const write = jest.spyOn(table, "bulkPut").mockImplementation(() =>
    Dexie.Promise.resolve().then(() => {
      current = false
      return "cancelled"
    })
  )
  try {
    await expect(
      applyBotDeliveryRows([delivery("cancelled")], Date.now(), () => {
        if (!current) throw new Error("scope cancelled")
      })
    ).rejects.toThrow("scope cancelled")
    expect(write).toHaveBeenCalledTimes(1)
    expect(read).not.toHaveBeenCalled()
  } finally {
    read.mockRestore()
    write.mockRestore()
  }
})

it("fences retention deletion after reading expired victims", async () => {
  const table = getDb().botEventDeliveries
  const row = delivery("cancel-aged", { status: "succeeded", syncedFromHost: true, receivedAt: 0 })
  await table.put(row)
  const remove = jest.spyOn(table, "bulkDelete")
  const assertCurrent = jest.fn(() => {
    throw new Error("scope cancelled")
  })
  try {
    await expect(sweepAgedMirroredDeliveries(Date.now(), assertCurrent)).rejects.toThrow(
      "scope cancelled"
    )
    expect(assertCurrent).toHaveBeenCalledTimes(1)
    expect(remove).not.toHaveBeenCalled()
    expect(await table.get(row.id)).toBeDefined()
  } finally {
    remove.mockRestore()
  }
})
