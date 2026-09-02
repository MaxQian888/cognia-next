/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

import type { Transport } from "@/lib/tauri/transport-types"
import type { ConnectorCallbackBindingRow } from "@/types/connectors/interaction"
import { getDb, __resetDbForTesting } from "@/lib/db/schema"
import { LEGACY_GRACE_MS } from "@/lib/connectors/callback-binding-cleanup"

import {
  MIRROR_BINDING_LEGACY_GRACE_MS,
  applyConnectorCallbackBindingRows,
  bindingExpiresAt,
  sweepExpiredMirroredBindings,
  syncConnectorCallbackBindings,
} from "./connector-callback-bindings"

function binding(
  actionId: string,
  over: Partial<ConnectorCallbackBindingRow> = {}
): ConnectorCallbackBindingRow {
  return {
    id: `tg-1:${actionId}`,
    adapterId: "tg-1",
    actionId,
    kind: "callback_query",
    surfaceId: "surface-1",
    conversationKey: "telegram:tg-1:chat",
    createdAt: 100,
    expiresAt: 1_000,
    ...over,
  }
}

function makeTransport(rows: ConnectorCallbackBindingRow[] = []): Transport {
  return {
    call: jest.fn(async () => ({
      rows,
      deleted_ids: [],
      next_since: 7,
    })) as unknown as Transport["call"],
    subscribe: jest.fn(() => () => {}) as unknown as Transport["subscribe"],
  }
}

describe("syncConnectorCallbackBindings", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("expires legacy rows on the host cleanup's own grace window", () => {
    expect(MIRROR_BINDING_LEGACY_GRACE_MS).toBe(LEGACY_GRACE_MS)
    expect(bindingExpiresAt({ createdAt: 10, expiresAt: 50 })).toBe(50)
    expect(bindingExpiresAt({ createdAt: 10 })).toBe(10 + LEGACY_GRACE_MS)
  })

  it("pulls connectorCallbackBindings and mirrors the rows", async () => {
    // A fixture that is already expired would be swept on apply, so keep it live.
    const tx = makeTransport([
      binding("approve", { consumedAt: 500, expiresAt: Date.now() + 60_000 }),
    ])
    const out = await syncConnectorCallbackBindings(tx, { since: 0 })
    expect(tx.call).toHaveBeenCalledWith("sync_pull", {
      table: "connectorCallbackBindings",
      since: 0,
      content_protocol_version: 1,
    })
    expect(out.ok).toBe(true)
    expect(await getDb().connectorCallbackBindings.get("tg-1:approve")).toMatchObject({
      kind: "callback_query",
      consumedAt: 500,
    })
  })

  it("sweeps rows whose expiry has passed, explicit or legacy, on every apply", async () => {
    const now = 10_000_000_000
    await getDb().connectorCallbackBindings.bulkPut([
      binding("expired", { expiresAt: now - 1 }),
      binding("live", { expiresAt: now + 1 }),
      binding("legacy-old", { expiresAt: undefined, createdAt: now - LEGACY_GRACE_MS - 1 }),
      binding("legacy-new", { expiresAt: undefined, createdAt: now - 1 }),
    ])
    await applyConnectorCallbackBindingRows([binding("fresh", { expiresAt: now + 10 })], now)
    const ids = (await getDb().connectorCallbackBindings.toArray())
      .map((row) => row.actionId)
      .sort()
    expect(ids).toEqual(["fresh", "legacy-new", "live"])
  })

  it("sweeps nothing when every row is live", async () => {
    await getDb().connectorCallbackBindings.put(binding("live", { expiresAt: 2_000 }))
    expect(await sweepExpiredMirroredBindings(1_500)).toBe(0)
  })
})
