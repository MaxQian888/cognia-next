jest.mock("@/lib/tauri", () => ({
  ...jest.requireActual("@/lib/tauri"),
  isTauri: jest.fn(),
}))

jest.mock("@cognia/vector/invoke", () => ({
  vectorCloudInvoke: { saveCredentials: jest.fn() },
}))

import { isTauri } from "@/lib/tauri"
import {
  getTwinRuntimeSettings,
  registerExistingTwinVectorBackend,
  saveTwinRuntimeSettings,
} from "./twin-runtime-settings"
import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"
import { DEFAULT_TWIN_RUNTIME_SETTINGS, type TwinRuntimeSettings } from "@/types/twin"
import { vectorCloudInvoke } from "@cognia/vector/invoke"
import { useVectorStore } from "@/stores/vector/vector-store"

const mockedIsTauri = isTauri as jest.MockedFunction<typeof isTauri>
const saveVectorCredentials = vectorCloudInvoke.saveCredentials as jest.MockedFunction<
  typeof vectorCloudInvoke.saveCredentials
>

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  mockedIsTauri.mockReturnValue(false)
  saveVectorCredentials.mockReset().mockResolvedValue(undefined)
  useVectorStore.getState().reset()
})
afterAll(dbFixture.dispose)

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

    const persisted = await (
      getDb().settings as unknown as { get(id: string): Promise<{ payload: TwinRuntimeSettings }> }
    ).get("twin-runtime")
    expect(persisted.payload.embedding.apiKey).toBe("")
    expect(persisted.payload.llm.apiKey).toBe("")
    expect(persisted.payload.storage.qdrant?.apiKey).toBeUndefined()
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

  it("preserves durable references when the Web Vault is unavailable", async () => {
    await (
      getDb().settings as unknown as {
        put(row: unknown): Promise<unknown>
      }
    ).put({
      id: "twin-runtime",
      payload: DEFAULT_TWIN_RUNTIME_SETTINGS,
      secretRefs: { embedding: "embedding-api-key" },
    })

    await saveTwinRuntimeSettings(DEFAULT_TWIN_RUNTIME_SETTINGS)

    const persisted = await (
      getDb().settings as unknown as {
        get(id: string): Promise<{ secretRefs?: { embedding?: string } }>
      }
    ).get("twin-runtime")
    expect(persisted.secretRefs?.embedding).toBe("embedding-api-key")
  })

  it("round-trips extraNameHints incl. CJK names", async () => {
    await saveTwinRuntimeSettings({
      ...DEFAULT_TWIN_RUNTIME_SETTINGS,
      extraNameHints: ["Alice Zhang", "张伟"],
    })
    const loaded = await getTwinRuntimeSettings()
    expect(loaded.extraNameHints).toEqual(["Alice Zhang", "张伟"])
  })

  it("registers complete cloud vector credentials when saving Tauri settings", async () => {
    mockedIsTauri.mockReturnValue(true)
    await saveTwinRuntimeSettings({
      ...DEFAULT_TWIN_RUNTIME_SETTINGS,
      storage: {
        vectorBackend: "qdrant",
        qdrant: { url: "http://localhost:6334", apiKey: "qdrant-secret" },
      },
    })

    expect(saveVectorCredentials).toHaveBeenCalledWith("twin-runtime-qdrant", {
      provider: "qdrant",
      url: "http://localhost:6334",
      api_key: "qdrant-secret",
      collection_name: undefined,
    })
    expect(useVectorStore.getState().settings).toMatchObject({
      provider: "qdrant",
      embeddingProvider: DEFAULT_TWIN_RUNTIME_SETTINGS.embedding.provider,
      embeddingModel: DEFAULT_TWIN_RUNTIME_SETTINGS.embedding.model,
      qdrantConfigId: "twin-runtime-qdrant",
    })
  })

  it("backfills the Rust vector registry once at boot for existing Tauri settings", async () => {
    const settings = {
      ...DEFAULT_TWIN_RUNTIME_SETTINGS,
      storage: {
        vectorBackend: "qdrant" as const,
        qdrant: { url: "http://localhost:6334", apiKey: "existing-secret" },
      },
    }
    await saveTwinRuntimeSettings(settings)
    saveVectorCredentials.mockClear()
    mockedIsTauri.mockReturnValue(true)

    await registerExistingTwinVectorBackend()

    expect(saveVectorCredentials).toHaveBeenCalledWith("twin-runtime-qdrant", {
      provider: "qdrant",
      url: "http://localhost:6334",
      api_key: "existing-secret",
      collection_name: undefined,
    })
    expect(useVectorStore.getState().settings).toMatchObject({
      provider: "qdrant",
      qdrantConfigId: "twin-runtime-qdrant",
    })
  })

  it("keeps reading settings free of registry writes", async () => {
    await saveTwinRuntimeSettings({
      ...DEFAULT_TWIN_RUNTIME_SETTINGS,
      storage: {
        vectorBackend: "qdrant",
        qdrant: { url: "http://localhost:6334", apiKey: "existing-secret" },
      },
    })
    mockedIsTauri.mockReturnValue(true)
    saveVectorCredentials.mockClear()

    // Reading settings must not touch the keyring or the shared vector store —
    // the startup probe and every runtime-adapter build go through this call.
    await expect(getTwinRuntimeSettings()).resolves.toMatchObject({
      storage: { vectorBackend: "qdrant", qdrant: { url: "http://localhost:6334" } },
    })
    expect(saveVectorCredentials).not.toHaveBeenCalled()
  })

  it("backfills a no-auth cloud endpoint even when the legacy row has no secret references", async () => {
    await (getDb().settings as unknown as { put(row: unknown): Promise<unknown> }).put({
      id: "twin-runtime",
      payload: {
        ...DEFAULT_TWIN_RUNTIME_SETTINGS,
        storage: {
          vectorBackend: "weaviate",
          weaviate: { url: "https://weaviate.example" },
        },
      },
    })
    mockedIsTauri.mockReturnValue(true)

    await registerExistingTwinVectorBackend()

    expect(saveVectorCredentials).toHaveBeenCalledWith("twin-runtime-weaviate", {
      provider: "weaviate",
      url: "https://weaviate.example",
      api_key: undefined,
    })
    expect(useVectorStore.getState().settings).toMatchObject({
      provider: "weaviate",
      weaviateConfigId: "twin-runtime-weaviate",
    })
  })

  // The keyring write is a second durable step, not a precondition. Aborting
  // the row write on its failure left the user unable to change the backend or
  // switch the worker off, because nothing they typed was ever persisted.
  it("still persists the row when the vector keyring write fails, and reports the failure", async () => {
    mockedIsTauri.mockReturnValue(true)
    saveVectorCredentials.mockRejectedValue(new Error("keyring locked"))

    await expect(
      saveTwinRuntimeSettings({
        ...DEFAULT_TWIN_RUNTIME_SETTINGS,
        workerEnabled: false,
        storage: {
          vectorBackend: "weaviate",
          weaviate: { url: "https://weaviate.example", apiKey: "secret" },
        },
      })
    ).rejects.toThrow("keyring locked")

    const loaded = await getTwinRuntimeSettings()
    expect(loaded.workerEnabled).toBe(false)
    expect(loaded.storage.vectorBackend).toBe("weaviate")
    // No config id was registered, so the shared store must not claim one.
    expect(useVectorStore.getState().settings.weaviateConfigId).toBeUndefined()
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
