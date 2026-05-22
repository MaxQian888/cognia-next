/**
 * Local pack store tests (ADR-0030). Use an in-memory fs adapter so
 * we don't depend on Tauri or the real filesystem; the store's own
 * `__setLocalPackFsForTesting` hook injects it.
 */

jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(() => true),
  isCapacitor: jest.fn(() => false),
}))

import {
  __resetLocalPackStoreForTesting,
  __setLocalPackFsForTesting,
  CHARACTER_PACK_FILE_SCHEMA_VERSION,
  LOCAL_PACK_PLUGIN_ID,
  deleteLocalPack,
  exportPack,
  importLocalPack,
  scanAndRegisterLocalPacks,
  type LocalPackFsAdapter,
} from "./local-pack-store"
import {
  getCharacterPack,
  getCharacterPackEntry,
  registerCharacterPack,
} from "@/lib/plugin/registries/character-pack-registry"
import { serializeLocalPackFile } from "./schema"
import { isTauri } from "@/lib/tauri"
import type { PluginCharacterPackDef } from "@/types/plugin/plugin-character-pack"

const mIsTauri = isTauri as jest.Mock

function makePack(overrides: Partial<PluginCharacterPackDef> = {}): PluginCharacterPackDef {
  return {
    id: "workplace",
    name: "Workplace Suite",
    version: "1.0.0",
    characters: [
      {
        localId: "alice",
        name: "Alice",
        avatarColor: "oklch(0.7 0.15 250)",
        systemPrompt: "Hello",
      },
    ],
    ...overrides,
  }
}

function makeInMemoryFs(initialFiles: Record<string, string> = {}): {
  adapter: LocalPackFsAdapter
  files: Map<string, string>
} {
  const files = new Map<string, string>(Object.entries(initialFiles))
  const ROOT = "/mem/cognia/local-character-packs"
  const adapter: LocalPackFsAdapter = {
    resolveDir: async () => ROOT,
    listFiles: async () => {
      const out: string[] = []
      for (const path of files.keys()) {
        if (path.startsWith(ROOT + "/") && path.endsWith(".cognia-pack.json")) {
          out.push(path.slice(ROOT.length + 1))
        }
      }
      return out
    },
    readFile: async (path) => files.get(path) ?? null,
    writeFile: async (path, body) => {
      files.set(path, body)
    },
    deleteFile: async (path) => {
      files.delete(path)
    },
    pathFor: async (dir, packId) => `${dir}/${packId}.cognia-pack.json`,
  }
  return { adapter, files }
}

beforeEach(() => {
  __resetLocalPackStoreForTesting()
  mIsTauri.mockReturnValue(true)
})

describe("scanAndRegisterLocalPacks", () => {
  it("registers every valid .cognia-pack.json found in the directory", async () => {
    const pack = makePack({ id: "workplace" })
    const { adapter } = makeInMemoryFs({
      "/mem/cognia/local-character-packs/workplace.cognia-pack.json": serializeLocalPackFile(pack),
    })
    __setLocalPackFsForTesting(adapter)

    const result = await scanAndRegisterLocalPacks()
    expect(result.registered).toEqual(["workplace"])
    expect(result.skipped).toEqual([])
    expect(getCharacterPackEntry("workplace")).toEqual({
      entry: pack,
      pluginId: LOCAL_PACK_PLUGIN_ID,
    })
  })

  it("skips files with invalid JSON or bad schema, without aborting the scan", async () => {
    const goodPack = makePack({ id: "good" })
    const { adapter } = makeInMemoryFs({
      "/mem/cognia/local-character-packs/good.cognia-pack.json": serializeLocalPackFile(goodPack),
      "/mem/cognia/local-character-packs/bad-json.cognia-pack.json": "{not json",
      "/mem/cognia/local-character-packs/bad-schema.cognia-pack.json": JSON.stringify({
        schemaVersion: 1,
        pack: { id: "bad", name: "Bad" }, // missing version + characters
      }),
    })
    __setLocalPackFsForTesting(adapter)

    const result = await scanAndRegisterLocalPacks()
    expect(result.registered).toEqual(["good"])
    expect(result.skipped).toHaveLength(2)
    expect(result.skipped.map((s) => s.filename).sort()).toEqual([
      "bad-json.cognia-pack.json",
      "bad-schema.cognia-pack.json",
    ])
  })

  it("returns empty result when resolveDir returns null (web mode)", async () => {
    const adapter: LocalPackFsAdapter = {
      resolveDir: async () => null,
      listFiles: async () => [],
      readFile: async () => null,
      writeFile: async () => {},
      deleteFile: async () => {},
      pathFor: async (dir, id) => `${dir}/${id}.cognia-pack.json`,
    }
    __setLocalPackFsForTesting(adapter)
    const result = await scanAndRegisterLocalPacks()
    expect(result).toEqual({ registered: [], skipped: [] })
  })
})

describe("importLocalPack", () => {
  it("writes the file and registers the pack atomically", async () => {
    const { adapter, files } = makeInMemoryFs()
    __setLocalPackFsForTesting(adapter)

    const pack = makePack({ id: "study" })
    const result = await importLocalPack({
      schemaVersion: CHARACTER_PACK_FILE_SCHEMA_VERSION,
      pack,
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.packId).toBe("study")

    expect(files.has("/mem/cognia/local-character-packs/study.cognia-pack.json")).toBe(true)
    expect(getCharacterPack("study")).toEqual(pack)
  })

  it("accepts a raw JSON string payload", async () => {
    const { adapter } = makeInMemoryFs()
    __setLocalPackFsForTesting(adapter)
    const body = serializeLocalPackFile(makePack({ id: "study" }))

    const result = await importLocalPack(body)
    expect(result.ok).toBe(true)
    expect(getCharacterPack("study")).toBeDefined()
  })

  it("rejects malformed JSON strings", async () => {
    const { adapter } = makeInMemoryFs()
    __setLocalPackFsForTesting(adapter)

    const result = await importLocalPack("not json")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/Invalid JSON/)
  })

  it("rejects malformed pack payloads", async () => {
    const { adapter } = makeInMemoryFs()
    __setLocalPackFsForTesting(adapter)

    const result = await importLocalPack({ schemaVersion: 1, pack: { id: "x" } })
    expect(result.ok).toBe(false)
  })

  it("refuses to overwrite a pack id already owned by a real plugin", async () => {
    const { adapter } = makeInMemoryFs()
    __setLocalPackFsForTesting(adapter)
    // A real plugin has already registered the id.
    registerCharacterPack("workplace", makePack({ id: "workplace" }), { pluginId: "plug-a" })

    const result = await importLocalPack({
      schemaVersion: 1,
      pack: makePack({ id: "workplace" }),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/already provided by plugin/)
  })

  it("overwrites a previously imported local pack with the same id (re-import)", async () => {
    const { adapter, files } = makeInMemoryFs()
    __setLocalPackFsForTesting(adapter)

    const v1 = await importLocalPack({
      schemaVersion: 1,
      pack: makePack({ id: "study", version: "1.0.0" }),
    })
    expect(v1.ok).toBe(true)

    const v2 = await importLocalPack({
      schemaVersion: 1,
      pack: makePack({ id: "study", version: "1.1.0" }),
    })
    expect(v2.ok).toBe(true)
    expect(getCharacterPack("study")?.version).toBe("1.1.0")
    expect(files.size).toBe(1)
  })

  it("rejects imports in web mode", async () => {
    mIsTauri.mockReturnValue(false)
    const result = await importLocalPack({ schemaVersion: 1, pack: makePack() })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/not available in web mode/)
  })
})

describe("deleteLocalPack", () => {
  it("unregisters the pack and removes the file", async () => {
    const pack = makePack({ id: "study" })
    const { adapter, files } = makeInMemoryFs({
      "/mem/cognia/local-character-packs/study.cognia-pack.json": serializeLocalPackFile(pack),
    })
    __setLocalPackFsForTesting(adapter)
    await scanAndRegisterLocalPacks()
    expect(getCharacterPack("study")).toBeDefined()

    const result = await deleteLocalPack("study")
    expect(result.ok).toBe(true)
    expect(getCharacterPack("study")).toBeUndefined()
    expect(files.has("/mem/cognia/local-character-packs/study.cognia-pack.json")).toBe(false)
  })

  it("refuses to delete a pack provided by a real plugin", async () => {
    const { adapter } = makeInMemoryFs()
    __setLocalPackFsForTesting(adapter)
    registerCharacterPack("workplace", makePack({ id: "workplace" }), { pluginId: "plug-a" })

    const result = await deleteLocalPack("workplace")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/disable the plugin/)
    // And the pack stays registered.
    expect(getCharacterPack("workplace")).toBeDefined()
  })

  it("returns an error for unknown pack ids", async () => {
    const { adapter } = makeInMemoryFs()
    __setLocalPackFsForTesting(adapter)
    const result = await deleteLocalPack("nope")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/not registered/)
  })
})

describe("exportPack", () => {
  it("round-trips a locally-imported pack through serialize → parse", async () => {
    const pack = makePack({ id: "study", version: "1.2.3" })
    const { adapter } = makeInMemoryFs()
    __setLocalPackFsForTesting(adapter)
    await importLocalPack({ schemaVersion: 1, pack })

    const result = exportPack("study")
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.filename).toBe("study.cognia-pack.json")
      const reparsed = JSON.parse(result.value.body)
      expect(reparsed.pack).toEqual(pack)
    }
  })

  it("exports a plugin-provided pack without retaining plugin identity", async () => {
    const { adapter } = makeInMemoryFs()
    __setLocalPackFsForTesting(adapter)
    const pack = makePack({ id: "workplace", version: "2.0.0" })
    registerCharacterPack("workplace", pack, { pluginId: "plug-a" })

    const result = exportPack("workplace")
    expect(result.ok).toBe(true)
    if (result.ok) {
      const parsed = JSON.parse(result.value.body)
      // The file format carries no plugin identity — a re-import becomes local:imported.
      expect(parsed.pack.id).toBe("workplace")
      expect(parsed.signature).toBeUndefined()
    }
  })

  it("returns an error for unknown pack ids", () => {
    const result = exportPack("nope")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/not registered/)
  })
})
