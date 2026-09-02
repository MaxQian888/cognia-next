/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

import type { Transport } from "@/lib/tauri/transport-types"
import type { ConnectorHeartbeatRow } from "@/lib/db/connector-types"
import { getDb, __resetDbForTesting } from "@/lib/db/schema"
import { HEARTBEAT_RETENTION_MS } from "@/lib/connectors/health/heartbeat"

import {
  MIRROR_HEARTBEAT_RETENTION_MS,
  applyConnectorHeartbeatRows,
  sweepAgedMirroredHeartbeats,
  syncConnectorHeartbeats,
} from "./connector-heartbeats"

function makeTransport(rows: ConnectorHeartbeatRow[] = []): Transport {
  return {
    call: jest.fn(async () => ({
      rows,
      deleted_ids: [],
      next_since: 21,
    })) as unknown as Transport["call"],
    subscribe: jest.fn(() => () => {}) as unknown as Transport["subscribe"],
  }
}

function beat(id: string, at: number, adapterId = "tg-1"): ConnectorHeartbeatRow {
  return { id, adapterId, kind: "adapter.heartbeat", at, fields: { state: "healthy" } }
}

describe("syncConnectorHeartbeats", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("ages the mirror out on the host's own retention window", () => {
    expect(MIRROR_HEARTBEAT_RETENTION_MS).toBe(HEARTBEAT_RETENTION_MS)
  })

  it("pulls connectorHeartbeats and mirrors the rows", async () => {
    // Epoch-1970 fixtures would be swept as aged on apply, so stamp it now.
    const at = Date.now() - 10
    const tx = makeTransport([beat("h1", at)])
    const out = await syncConnectorHeartbeats(tx, { since: 0 })
    expect(tx.call).toHaveBeenCalledWith("sync_pull", {
      table: "connectorHeartbeats",
      since: 0,
      content_protocol_version: 1,
    })
    expect(out).toEqual({
      ok: true,
      result: { table: "connectorHeartbeats", applied: 1, nextSince: 21 },
    })
    expect(await getDb().connectorHeartbeats.get("h1")).toMatchObject({ adapterId: "tg-1", at })
  })

  it("sweeps mirrored rows older than the retention window on every apply", async () => {
    const now = 10_000_000_000
    await getDb().connectorHeartbeats.bulkPut([
      beat("old", now - MIRROR_HEARTBEAT_RETENTION_MS - 1),
      beat("edge", now - MIRROR_HEARTBEAT_RETENTION_MS),
    ])
    await applyConnectorHeartbeatRows([beat("fresh", now)], now)
    const ids = (await getDb().connectorHeartbeats.toArray()).map((row) => row.id).sort()
    expect(ids).toEqual(["edge", "fresh"])
  })

  it("sweeps nothing when every row is within the window", async () => {
    const now = 10_000_000_000
    await getDb().connectorHeartbeats.put(beat("fresh", now - 1))
    expect(await sweepAgedMirroredHeartbeats(now)).toBe(0)
  })
})
