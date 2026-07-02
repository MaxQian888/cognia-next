import "fake-indexeddb/auto"

jest.mock("@/lib/tauri", () => ({
  ...jest.requireActual("@/lib/tauri"),
  isTauri: jest.fn(),
}))

import { isTauri } from "@/lib/tauri"
import { getTwinRuntimeSettings, saveTwinRuntimeSettings } from "./twin-runtime-settings"
import { __resetDbForTesting, getDb, whenSeeded } from "./schema"
import { DEFAULT_TWIN_RUNTIME_SETTINGS } from "@/types/twin"

const mockedIsTauri = isTauri as jest.MockedFunction<typeof isTauri>

beforeEach(async () => {
  mockedIsTauri.mockReturnValue(false)
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

describe("twin-runtime-settings CRUD", () => {
  it("returns defaults when no row exists", async () => {
    const settings = await getTwinRuntimeSettings()
    expect(settings).toEqual(DEFAULT_TWIN_RUNTIME_SETTINGS)
  })

  it("round-trips a saved value", async () => {
    await saveTwinRuntimeSettings({
      ...DEFAULT_TWIN_RUNTIME_SETTINGS,
      workerEnabled: true,
      embedding: { provider: "openai", model: "text-embedding-3-large", apiKey: "sk-test" },
      storage: {
        vectorBackend: "qdrant",
        qdrant: { url: "http://localhost:6333", apiKey: "qd-key" },
      },
      llm: { provider: "anthropic", model: "claude-sonnet-4-6", apiKey: "sk-anthropic" },
    })
    const loaded = await getTwinRuntimeSettings()
    expect(loaded.workerEnabled).toBe(true)
    expect(loaded.embedding.model).toBe("text-embedding-3-large")
    expect(loaded.storage.qdrant?.url).toBe("http://localhost:6333")
    expect(loaded.llm.apiKey).toBe("sk-anthropic")
  })

  it("backfills missing nested fields from defaults on read", async () => {
    // Simulate a partial row written by an older release.
    const db = getDb()
    await (db.settings as unknown as { put(row: unknown): Promise<unknown> }).put({
      id: "twin-runtime",
      payload: {
        workerEnabled: true,
        // storage / embedding / llm intentionally missing some fields
        storage: { vectorBackend: "pinecone" },
        embedding: { provider: "openai", model: "text-embedding-3-small" },
        llm: { provider: "anthropic", model: "claude-sonnet-4-6" },
      },
    })
    const loaded = await getTwinRuntimeSettings()
    expect(loaded.embedding.apiKey).toBe("")
    expect(loaded.llm.apiKey).toBe("")
    expect(loaded.storage.vectorBackend).toBe("pinecone")
    // Older rows never wrote extraNameHints — must backfill to [] not crash.
    expect(loaded.extraNameHints).toEqual([])
  })

  it("round-trips extraNameHints incl. CJK names", async () => {
    await saveTwinRuntimeSettings({
      ...DEFAULT_TWIN_RUNTIME_SETTINGS,
      extraNameHints: ["Alice Zhang", "张伟"],
    })
    const loaded = await getTwinRuntimeSettings()
    expect(loaded.extraNameHints).toEqual(["Alice Zhang", "张伟"])
  })

  it("ignores rows whose id doesn't match the twin-runtime key", async () => {
    // The settings table also hosts the AppSettings singleton; ensure the
    // getter doesn't accidentally claim it.
    const db = getDb()
    await (db.settings as unknown as { put(row: unknown): Promise<unknown> }).put({
      id: "singleton",
      payload: { workerEnabled: true },
    })
    const loaded = await getTwinRuntimeSettings()
    expect(loaded).toEqual(DEFAULT_TWIN_RUNTIME_SETTINGS)
  })
})

describe("twin-runtime-settings vectorBackend derived default", () => {
  it("defaults vectorBackend to 'native' when isTauri() is true and no persisted value exists", async () => {
    mockedIsTauri.mockReturnValue(true)
    const settings = await getTwinRuntimeSettings()
    expect(settings.storage.vectorBackend).toBe("native")
  })

  it("defaults vectorBackend to 'qdrant' when isTauri() is false and no persisted value exists", async () => {
    mockedIsTauri.mockReturnValue(false)
    const settings = await getTwinRuntimeSettings()
    expect(settings.storage.vectorBackend).toBe("qdrant")
  })

  it("preserves a persisted vectorBackend value over the derived default (regression: existing users keep their choice)", async () => {
    // Even when isTauri() is true (would default to "native"), a user who
    // explicitly chose "qdrant" and has it persisted must not have it silently
    // migrated to "native".
    mockedIsTauri.mockReturnValue(true)
    await saveTwinRuntimeSettings({
      ...DEFAULT_TWIN_RUNTIME_SETTINGS,
      storage: { vectorBackend: "qdrant" },
    })
    const loaded = await getTwinRuntimeSettings()
    expect(loaded.storage.vectorBackend).toBe("qdrant")
  })

  it("defaults vectorBackend to 'native' via merge when row exists but lacks storage.vectorBackend", async () => {
    // Simulate an older row that pre-dates the vectorBackend field.
    mockedIsTauri.mockReturnValue(true)
    const db = getDb()
    await (db.settings as unknown as { put(row: unknown): Promise<unknown> }).put({
      id: "twin-runtime",
      payload: {
        workerEnabled: false,
        // storage is entirely absent — simulates a very old row
      },
    })
    const loaded = await getTwinRuntimeSettings()
    expect(loaded.storage.vectorBackend).toBe("native")
  })
})
