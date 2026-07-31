/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import Dexie from "dexie"
import { CogniaDB, __resetDbForTesting, getDb, whenSeeded } from "./schema"

// The pre-v88 upgrade test needs the real version chain — opt out of the
// Jest collapsed-schema fast path (which declares only the latest version).
;(globalThis as { __COGNIA_DB_FULL_SCHEMA__?: boolean }).__COGNIA_DB_FULL_SCHEMA__ = true
import {
  clearWasmGrantRecords,
  listWasmGrantRecords,
  replaceWasmGrantRecords,
} from "./wasm-grant-ledger"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
})

afterEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
})

describe("wasmGrantLedger schema", () => {
  it("registers the v88 WASM grant ledger table", async () => {
    const db = getDb()
    await whenSeeded()
    expect(db.verno).toBeGreaterThanOrEqual(88)

    await replaceWasmGrantRecords("plugin.wasm", ["/tmp/b", "/tmp/a"], "user", 123)

    expect(await listWasmGrantRecords("plugin.wasm")).toEqual([
      expect.objectContaining({ pluginId: "plugin.wasm", preopen: "/tmp/a", source: "user" }),
      expect.objectContaining({ pluginId: "plugin.wasm", preopen: "/tmp/b", source: "user" }),
    ])
  })

  it("opens a pre-v88 database and upgrades it with the ledger table", async () => {
    const name = `cognia-wasm-ledger-upgrade-${Date.now()}`
    const legacy = new Dexie(name)
    legacy.version(87).stores({
      backgroundTasks: "&runId",
    })
    await legacy.open()
    legacy.close()

    const upgraded = new CogniaDB(name)
    await upgraded.open()
    await upgraded.wasmGrantLedger.put({
      id: "plugin.wasm:/tmp/a",
      pluginId: "plugin.wasm",
      preopen: "/tmp/a",
      source: "user",
      grantedAt: 1,
    })

    expect(await upgraded.wasmGrantLedger.get("plugin.wasm:/tmp/a")).toEqual(
      expect.objectContaining({ preopen: "/tmp/a" })
    )
    await upgraded.delete()
    upgraded.close()
  })
})

describe("wasm grant ledger helpers", () => {
  it("replaceWasmGrantRecords replaces stale rows atomically", async () => {
    await replaceWasmGrantRecords("plugin.wasm", ["/old"], "user", 1)
    await replaceWasmGrantRecords("plugin.wasm", ["/new"], "system", 2)

    expect(await listWasmGrantRecords("plugin.wasm")).toEqual([
      expect.objectContaining({ preopen: "/new", source: "system", grantedAt: 2 }),
    ])
  })

  it("clearWasmGrantRecords removes only the selected plugin", async () => {
    await replaceWasmGrantRecords("plugin.a", ["/a"], "user", 1)
    await replaceWasmGrantRecords("plugin.b", ["/b"], "user", 1)

    await clearWasmGrantRecords("plugin.a")

    expect(await listWasmGrantRecords("plugin.a")).toEqual([])
    expect(await listWasmGrantRecords("plugin.b")).toHaveLength(1)
  })
})
