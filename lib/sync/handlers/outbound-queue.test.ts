/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"
import Dexie from "dexie"

import type { Transport } from "@/lib/tauri/transport-types"
import type { OutboundJobRow } from "@/lib/db/connector-types"
import { getDb, __resetDbForTesting } from "@/lib/db/schema"
import {
  listDueNow,
  pickNextDue,
  recoverStaleSendingJobs,
  markSending,
} from "@/lib/db/outbound-jobs"

import {
  MIRROR_TERMINAL_RETENTION_MS,
  applyOutboundQueueRows,
  normalizeMirroredOutboundRow,
  sweepAgedMirroredRows,
  syncOutboundQueue,
} from "./outbound-queue"

function makeTransport(rows: OutboundJobRow[] = []): Transport {
  return {
    call: jest.fn(async () => ({
      rows,
      deleted_ids: [],
      next_since: 21,
    })) as unknown as Transport["call"],
    subscribe: jest.fn(() => () => {}) as unknown as Transport["subscribe"],
  }
}

function job(id: string, over: Partial<OutboundJobRow> = {}): OutboundJobRow {
  return {
    id,
    adapterId: "tg",
    conversationKey: "telegram:tg:1",
    request: {
      conversationRef: { platform: "telegram", adapterId: "tg" },
      segments: [],
      metadata: { idempotencyKey: `k-${id}` },
    },
    status: "pending",
    attempts: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    nextAttemptAt: 0,
    idempotencyKey: `k-${id}`,
    source: "manual",
    syncedFromHost: true,
    ...over,
  }
}

describe("syncOutboundQueue", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("pulls outboundQueue and mirrors the projection", async () => {
    const tx = makeTransport([job("j1", { status: "sent", platformMessageId: "pm1" })])
    const out = await syncOutboundQueue(tx, { since: 0 })
    expect(tx.call).toHaveBeenCalledWith("sync_pull", {
      table: "outboundQueue",
      since: 0,
      content_protocol_version: 1,
    })
    expect(out.ok).toBe(true)
    expect(await getDb().outboundQueue.get("j1")).toMatchObject({
      status: "sent",
      platformMessageId: "pm1",
      syncedFromHost: true,
      nextAttemptAt: 0,
    })
  })

  it("forces the projection shape even when the host sent a payload", () => {
    const normalized = normalizeMirroredOutboundRow({
      ...job("j2", { nextAttemptAt: 123 }),
      syncedFromHost: undefined,
      updatedAt: undefined,
      request: {
        conversationRef: { platform: "telegram", adapterId: "tg" },
        segments: [{ type: "text", text: "secret body" }],
        metadata: { idempotencyKey: "k-j2" },
      },
    } as OutboundJobRow)
    expect(normalized.syncedFromHost).toBe(true)
    expect(normalized.nextAttemptAt).toBe(0)
    expect(normalized.request.segments).toEqual([])
    expect(normalized.updatedAt).toBe(normalized.createdAt)
  })

  it("mirrored rows are invisible to the local runner", async () => {
    await applyOutboundQueueRows([
      job("j3", { status: "pending" }),
      job("j4", { status: "failed" }),
    ])
    expect(await listDueNow({ now: Date.now() + 1 })).toEqual([])
    expect(await pickNextDue(Date.now() + 1)).toBeUndefined()
    expect(await markSending("j3")).toBe(false)
    await applyOutboundQueueRows([job("j5", { status: "sending", claimedAt: 0, createdAt: 0 })])
    expect(await recoverStaleSendingJobs(Date.now())).toEqual([])
    expect((await getDb().outboundQueue.get("j5"))?.status).toBe("sending")
  })

  it("ages out terminal projections past the retention window, keeps active ones", async () => {
    const now = Date.now()
    const old = now - MIRROR_TERMINAL_RETENTION_MS - 1000
    await getDb().outboundQueue.bulkPut([
      job("old-sent", { status: "sent", createdAt: old }),
      job("old-dead", { status: "deadlettered", createdAt: old }),
      job("old-pending", { status: "pending", createdAt: old }),
      job("fresh-sent", { status: "sent", createdAt: now }),
      // A LOCAL terminal row (not mirrored) is the host's own retention business.
      job("local-old-sent", { status: "sent", createdAt: old, syncedFromHost: undefined }),
    ])
    expect(await sweepAgedMirroredRows(now)).toBe(2)
    const ids = (await getDb().outboundQueue.toArray()).map((row) => row.id).sort()
    expect(ids).toEqual(["fresh-sent", "local-old-sent", "old-pending"])
  })

  it("applying rows also runs the sweep", async () => {
    const now = Date.now()
    await getDb().outboundQueue.put(
      job("stale", { status: "sent", createdAt: now - MIRROR_TERMINAL_RETENTION_MS - 5 })
    )
    await applyOutboundQueueRows([job("new")], now)
    expect(await getDb().outboundQueue.get("stale")).toBeUndefined()
    expect(await getDb().outboundQueue.get("new")).toBeDefined()
  })
})

it("cancels before looking up the sweep table after an awaited apply", async () => {
  const table = getDb().outboundQueue
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
      applyOutboundQueueRows([job("cancelled")], Date.now(), () => {
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
  const table = getDb().outboundQueue
  const row = job("cancel-aged", { status: "sent", syncedFromHost: true, createdAt: 0 })
  await table.put(row)
  const remove = jest.spyOn(table, "bulkDelete")
  const assertCurrent = jest.fn(() => {
    throw new Error("scope cancelled")
  })
  try {
    await expect(sweepAgedMirroredRows(Date.now(), assertCurrent)).rejects.toThrow(
      "scope cancelled"
    )
    expect(assertCurrent).toHaveBeenCalledTimes(1)
    expect(remove).not.toHaveBeenCalled()
    expect(await table.get(row.id)).toBeDefined()
  } finally {
    remove.mockRestore()
  }
})
