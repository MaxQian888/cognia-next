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
      open: jest.fn(async () => order.push("open")),
      plugins: { toArray: jest.fn(async () => []) },
    }

    await ensureActiveDatabaseReady({
      getDatabase: () => database,
      getBuiltinPluginManifests: () => new Map(),
      restorePluginSchema: jest.fn(async () => {
        order.push("restore")
        return []
      }),
      verifySchema: jest.fn(() => undefined),
      seed: jest.fn(async () => order.push("seed")),
    } as never)

    expect(request).toHaveBeenCalledWith(
      "cognia-database-boot:cognia-account-locked",
      expect.any(Function)
    )
    expect(order).toEqual(["lock", "open", "restore", "seed", "unlock"])
  })

  it("opens, restores plugin schema, then seeds exactly once for concurrent callers", async () => {
    const order: string[] = []
    const database = {
      name: "cognia-account-test",
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
      open: jest.fn().mockRejectedValueOnce(new Error("open failed")).mockResolvedValue(undefined),
      plugins: { toArray: jest.fn(async () => []) },
    }
    const dependencies = {
      getDatabase: () => database,
      getBuiltinPluginManifests: () => new Map(),
      restorePluginSchema: jest.fn(async () => []),
      verifySchema: jest.fn(() => undefined),
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
