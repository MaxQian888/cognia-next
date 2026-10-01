/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

import { getDb } from "@/lib/db/schema"
import type { Transport } from "@/lib/tauri/transport-types"

import { syncPluginCogsets, syncPluginCogsetState } from "./plugin-cogsets"

function makeTransport(rows: unknown[] = []): Transport {
  return {
    call: jest.fn(async () => ({
      rows,
      deleted_ids: [],
      next_since: 9,
    })) as unknown as Transport["call"],
    subscribe: jest.fn(() => () => {}) as unknown as Transport["subscribe"],
  }
}

describe("cogset sync handlers", () => {
  it("pulls cogsets into the local mirror", async () => {
    const row = {
      id: "c1",
      name: "Writing",
      members: [],
      source: { kind: "manual" },
      createdAt: 1,
      updatedAt: 2,
    }
    const tx = makeTransport([row])
    const out = await syncPluginCogsets(tx, { since: 0 })
    expect(tx.call).toHaveBeenCalledWith("sync_pull", {
      table: "pluginCogsets",
      since: 0,
      content_protocol_version: 1,
    })
    expect(out.ok).toBe(true)
    expect(await getDb().pluginCogsets.get("c1")).toMatchObject({ name: "Writing" })
  })

  it("pulls the host's cogset state", async () => {
    const tx = makeTransport([
      { id: "host", alwaysOn: ["core"], appliedCogsetId: "c1", updatedAt: 3 },
    ])
    const out = await syncPluginCogsetState(tx, { since: 4 })
    expect(tx.call).toHaveBeenCalledWith("sync_pull", {
      table: "pluginCogsetState",
      since: 4,
      content_protocol_version: 1,
    })
    expect(out.ok).toBe(true)
    expect(await getDb().pluginCogsetState.get("host")).toMatchObject({ appliedCogsetId: "c1" })
  })
})
