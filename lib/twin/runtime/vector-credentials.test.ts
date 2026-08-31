import { vectorCloudInvoke } from "@cognia/vector/invoke"
import { DEFAULT_TWIN_RUNTIME_SETTINGS, type TwinRuntimeSettings } from "@/types/twin"
import { getTwinVectorConfigId, persistTwinVectorCredentials } from "./vector-credentials"

jest.mock("@cognia/vector/invoke", () => ({
  vectorCloudInvoke: { saveCredentials: jest.fn() },
}))

const saveCredentials = vectorCloudInvoke.saveCredentials as jest.MockedFunction<
  typeof vectorCloudInvoke.saveCredentials
>

function settings(storage: TwinRuntimeSettings["storage"]): TwinRuntimeSettings {
  return { ...DEFAULT_TWIN_RUNTIME_SETTINGS, storage }
}

beforeEach(() => {
  saveCredentials.mockReset().mockResolvedValue(undefined)
})

it.each([
  [
    "qdrant",
    { vectorBackend: "qdrant", qdrant: { url: "http://localhost:6334", apiKey: "q" } },
    {
      provider: "qdrant",
      url: "http://localhost:6334",
      api_key: "q",
      collection_name: undefined,
    },
  ],
  [
    "pinecone",
    { vectorBackend: "pinecone", pinecone: { apiKey: "p", indexName: "docs", namespace: "ns" } },
    { provider: "pinecone", api_key: "p", index_name: "docs", namespace: "ns" },
  ],
  [
    "weaviate",
    { vectorBackend: "weaviate", weaviate: { url: "https://w.example", apiKey: "w" } },
    { provider: "weaviate", url: "https://w.example", api_key: "w" },
  ],
  [
    "milvus",
    { vectorBackend: "milvus", milvus: { address: "localhost:19530", token: "m", ssl: true } },
    {
      provider: "milvus",
      address: "localhost:19530",
      token: "m",
      username: undefined,
      password: undefined,
      ssl: true,
      collection_name: undefined,
    },
  ],
  [
    "chroma",
    { vectorBackend: "chroma", chroma: { mode: "server", serverUrl: "http://localhost:8000" } },
    { provider: "chroma", url: "http://localhost:8000", auth_token: undefined },
  ],
] as const)(
  "persists %s credentials under a stable config id",
  async (provider, storage, expected) => {
    await expect(persistTwinVectorCredentials(settings(storage))).resolves.toBe(
      `twin-runtime-${provider}`
    )
    expect(saveCredentials).toHaveBeenCalledWith(`twin-runtime-${provider}`, expected)
  }
)

it("does not invent credentials for native or incomplete cloud settings", async () => {
  await expect(
    persistTwinVectorCredentials(settings({ vectorBackend: "native" }))
  ).resolves.toBeUndefined()
  await expect(
    persistTwinVectorCredentials(settings({ vectorBackend: "qdrant", qdrant: { url: "" } }))
  ).resolves.toBeUndefined()
  expect(saveCredentials).not.toHaveBeenCalled()
})

it("uses provider-specific ids so registry entries cannot collide", () => {
  expect(getTwinVectorConfigId("qdrant")).toBe("twin-runtime-qdrant")
  expect(getTwinVectorConfigId("pinecone")).toBe("twin-runtime-pinecone")
})
