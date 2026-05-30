/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

import { getDb } from "@/lib/db/schema"
import type { Transport } from "@/lib/tauri/transport-types"
import type { SyncDelta } from "../types"

import { syncAppSettings, CROSS_PLATFORM_SETTING_KEYS } from "./app-settings"

function makeTransport(delta: SyncDelta<{ id: string }>): Transport {
  return {
    call: jest.fn(async () => delta) as unknown as Transport["call"],
    subscribe: jest.fn(() => () => {}) as unknown as Transport["subscribe"],
  }
}

describe("syncAppSettings", () => {
  beforeEach(async () => {
    await getDb().settings.clear()
  })

  it("calls sync_pull with table=settings", async () => {
    const tx = makeTransport({ rows: [], deleted_ids: [], next_since: 4 })
    const out = await syncAppSettings(tx, { since: 0 })
    expect(tx.call).toHaveBeenCalledWith("sync_pull", { table: "settings", since: 0 })
    expect(out.ok).toBe(true)
  })

  it("writes the cross-platform fields from the delta", async () => {
    const tx = makeTransport({
      rows: [{ id: "singleton", theme: "dark" } as never],
      deleted_ids: [],
      next_since: 7,
    })
    const out = await syncAppSettings(tx, { since: 0 })
    expect(out.ok).toBe(true)
    expect((await getDb().settings.get("singleton"))?.theme).toBe("dark")
  })

  it("merges only cross-platform fields, preserving device-local ones", async () => {
    await getDb().settings.put({
      id: "singleton",
      alwaysAllowTools: [],
      builtinTools: {},
      apiKey: "phone-secret",
      theme: "light",
    } as never)

    const tx = makeTransport({
      rows: [
        { id: "singleton", theme: "dark", defaultModel: "opus", apiKey: "desktop-key" } as never,
      ],
      deleted_ids: [],
      next_since: 10,
    })
    await syncAppSettings(tx, { since: 0 })

    const row = await getDb().settings.get("singleton")
    expect(row?.theme).toBe("dark") // allowlisted → applied
    expect(row?.defaultModel).toBe("opus") // allowlisted → applied
    expect(row?.apiKey).toBe("phone-secret") // device-local → preserved
  })

  it("no-ops on an empty delta (settings already warm)", async () => {
    await getDb().settings.put({ id: "singleton", theme: "light" } as never)
    const out = await syncAppSettings(makeTransport({ rows: [], deleted_ids: [], next_since: 0 }), {
      since: 5,
    })
    expect(out.ok).toBe(true)
    expect((await getDb().settings.get("singleton"))?.theme).toBe("light")
  })

  it("excludes device-local keys from the cross-platform allowlist", () => {
    expect(CROSS_PLATFORM_SETTING_KEYS).toContain("theme")
    expect(CROSS_PLATFORM_SETTING_KEYS).not.toContain("apiKey" as never)
    expect(CROSS_PLATFORM_SETTING_KEYS).not.toContain("defaultWorkingDir" as never)
  })
})
