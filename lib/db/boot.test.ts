import type { PluginManifestDexieBlock } from "@/types/plugin"

import {
  assertPluginSchemaReady,
  collectPersistedPluginDexieManifests,
  ensureActiveDatabaseReady,
} from "./boot"

describe("database boot coordination", () => {
  afterEach(() => {
    delete (navigator as unknown as { locks?: unknown }).locks
  })

  it("holds a database-scoped Web Lock for the complete boot sequence", async () => {
    const order: string[] = []
    const request = jest.fn(async (_name: string, callback: () => Promise<unknown>) => {
      order.push("lock")
      const result = await callback()
      order.push("unlock")
      return result
    })
    Object.defineProperty(navigator, "locks", { value: { request }, configurable: true })
    const database = {
      name: "cognia-account-locked",
      tables: [{ name: "settings" }, { name: "plugins" }],
      open: jest.fn(async () => order.push("open")),
      plugins: { toArray: jest.fn(async () => []) },
    }
    const restorePluginSchema = jest.fn(async () => {
      order.push("restore")
      return []
    })
    const recreateDatabase = jest.fn(() => database)

    await ensureActiveDatabaseReady({
      getDatabase: () => database,
      getBuiltinPluginManifests: () => new Map(),
      restorePluginSchema,
      recreateDatabase,
      verifySchema: jest.fn(() => undefined),
      assertLayoutSupported: jest.fn(async () => undefined),
      markLayout: jest.fn(async () => undefined),
      seed: jest.fn(async () => order.push("seed")),
    } as never)

    expect(request).toHaveBeenCalledWith(
      "cognia-database-boot:cognia-account-locked",
      expect.any(Function)
    )
    expect(restorePluginSchema).toHaveBeenCalledWith(expect.any(Function), new Map(), {
      registerMissing: true,
      requiredStoreNames: ["settings", "plugins"],
      recreateDatabase,
    })
    expect(order).toEqual(["lock", "open", "restore", "seed", "unlock"])
  })

  it("refuses an unsupported storage layout before the database is opened", async () => {
    // Ordering is the whole point. Opening is what upgrades an older database
    // past the version where its layout can still be identified, so a check
    // that ran afterwards would always find a database that looks current.
    const order: string[] = []
    const database = {
      name: "cognia-account-refused",
      tables: [],
      open: jest.fn(async () => {
        order.push("open")
      }),
      plugins: { toArray: jest.fn(async () => []) },
    }
    const refusal = new Error("Local database was not written by this build (missing-marker).")

    await expect(
      ensureActiveDatabaseReady({
        getDatabase: () => database,
        getBuiltinPluginManifests: () => new Map(),
        restorePluginSchema: jest.fn(async () => []),
        recreateDatabase: jest.fn(() => database),
        verifySchema: jest.fn(() => undefined),
        assertLayoutSupported: jest.fn(async () => {
          order.push("assert")
          throw refusal
        }),
        markLayout: jest.fn(async () => undefined),
        seed: jest.fn(async () => undefined),
      } as never)
    ).rejects.toThrow(refusal)

    expect(order).toEqual(["assert"])
    expect(database.open).not.toHaveBeenCalled()
  })

  it("opens, restores plugin schema, then seeds exactly once for concurrent callers", async () => {
    const order: string[] = []
    const database = {
      name: "cognia-account-test",
      tables: [{ name: "settings" }],
      open: jest.fn(async () => {
        order.push("open")
      }),
      plugins: {
        toArray: jest.fn(async () => [
          {
            manifest: {
              id: "plugin-with-table",
              dexie: { tables: [{ name: "rows", schema: "&id" }] },
            },
          },
        ]),
      },
    }
    const restorePluginSchema = jest.fn(async (_source, manifests) => {
      order.push(`restore:${manifests.size}`)
      return ["plugin-with-table:rows"]
    })
    const seed = jest.fn(async () => {
      order.push("seed")
    })
    const dependencies = {
      getDatabase: () => database,
      getBuiltinPluginManifests: () => new Map(),
      restorePluginSchema,
      verifySchema: jest.fn(() => undefined),
      assertLayoutSupported: jest.fn(async () => undefined),
      markLayout: jest.fn(async () => undefined),
      seed,
    }

    const first = ensureActiveDatabaseReady(dependencies as never)
    const second = ensureActiveDatabaseReady(dependencies as never)
    await Promise.all([first, second])

    expect(order).toEqual(["open", "restore:1", "seed"])
    expect(database.open).toHaveBeenCalledTimes(1)
    expect(restorePluginSchema).toHaveBeenCalledTimes(1)
    expect(seed).toHaveBeenCalledTimes(1)
  })

  it("allows a failed boot to be retried without reusing the rejected promise", async () => {
    const database = {
      name: "cognia-account-retry",
      tables: [],
      open: jest.fn().mockRejectedValueOnce(new Error("open failed")).mockResolvedValue(undefined),
      plugins: { toArray: jest.fn(async () => []) },
    }
    const dependencies = {
      getDatabase: () => database,
      getBuiltinPluginManifests: () => new Map(),
      restorePluginSchema: jest.fn(async () => []),
      verifySchema: jest.fn(() => undefined),
      assertLayoutSupported: jest.fn(async () => undefined),
      markLayout: jest.fn(async () => undefined),
      seed: jest.fn(async () => undefined),
    }

    await expect(ensureActiveDatabaseReady(dependencies as never)).rejects.toThrow("open failed")
    await expect(ensureActiveDatabaseReady(dependencies as never)).resolves.toMatchObject({
      databaseName: "cognia-account-retry",
    })

    expect(database.open).toHaveBeenCalledTimes(2)
  })
})

describe("collectPersistedPluginDexieManifests", () => {
  it("keeps only valid persisted Dexie declarations", () => {
    const expected: PluginManifestDexieBlock = {
      tables: [{ name: "records", schema: "&id, createdAt" }],
    }

    const manifests = collectPersistedPluginDexieManifests([
      { manifest: { id: "valid", dexie: expected } },
      { manifest: { id: "missing-dexie" } },
      { manifest: { id: "invalid", dexie: { tables: "not-an-array" } } },
      { manifest: null },
    ])

    expect([...manifests.entries()]).toEqual([["valid", expected]])
  })
})

describe("assertPluginSchemaReady", () => {
  it("rejects a declaration missing from the Dexie or native schema", () => {
    const database = {
      name: "cognia-schema-check",
      verno: 144,
      tables: [{ name: "pluginDexieMeta" }],
      backendDB: () => ({ version: 1440, objectStoreNames: ["pluginDexieMeta"] }),
    }
    const manifests = new Map<string, PluginManifestDexieBlock>([
      ["plugin-a", { tables: [{ name: "rows", schema: "&id" }] }],
    ])

    expect(() => assertPluginSchemaReady(database as never, manifests)).toThrow("plugin-a:rows")
  })
})
