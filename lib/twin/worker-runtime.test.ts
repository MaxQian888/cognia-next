import { getTwinSource } from "@/lib/db/twin-sources"
import { DEFAULT_TWIN_RUNTIME_SETTINGS } from "@/types/twin"
import { buildTwinWorkerConfig, isTwinWorkerConfigComplete } from "./worker-runtime"

jest.mock("@/lib/db/twin-sources", () => ({ getTwinSource: jest.fn() }))
jest.mock("@/lib/twin/distill", () => ({
  createAnthropicLlmClient: jest.fn(() => ({ kind: "llm" })),
}))
jest.mock("@/lib/twin/runtime/build-deps", () => ({
  deriveTwinVectorStoreConfig: jest.fn((settings) =>
    settings.embedding.apiKey ? { provider: settings.storage.vectorBackend } : null
  ),
  buildTwinRuntimeAdapters: jest.fn(async (settings) =>
    settings.embedding.apiKey
      ? { ready: true, adapters: { store: { provider: settings.storage.vectorBackend } } }
      : { ready: false }
  ),
}))

const settings = {
  ...DEFAULT_TWIN_RUNTIME_SETTINGS,
  workerEnabled: true,
  embedding: { ...DEFAULT_TWIN_RUNTIME_SETTINGS.embedding, apiKey: "embedding-key" },
  llm: { ...DEFAULT_TWIN_RUNTIME_SETTINGS.llm, apiKey: "llm-key" },
}

describe("Twin worker runtime", () => {
  it("builds a shared all-twins worker config", async () => {
    ;(getTwinSource as jest.Mock).mockResolvedValue({
      id: "source-1",
      title: "Source",
      format: "markdown",
      source: "redacted body",
      speakers: ["Speaker"],
    })

    expect(isTwinWorkerConfigComplete(settings)).toBe(true)
    const config = await buildTwinWorkerConfig(settings)
    await expect(config?.sourceLoader({ id: "source-1" } as never)).resolves.toMatchObject({
      text: "redacted body",
      baseMetadata: { speakers: ["Speaker"] },
    })
  })

  it("does not build a config when disabled or incomplete", async () => {
    expect(isTwinWorkerConfigComplete({ ...settings, workerEnabled: false })).toBe(false)
    await expect(
      buildTwinWorkerConfig({ ...settings, llm: { ...settings.llm, apiKey: "" } })
    ).resolves.toBeNull()
  })

  it("returns null when the shared adapter reports not ready", async () => {
    const { buildTwinRuntimeAdapters } = jest.requireMock("@/lib/twin/runtime/build-deps") as {
      buildTwinRuntimeAdapters: jest.Mock
    }
    buildTwinRuntimeAdapters.mockResolvedValueOnce({
      ready: false,
      reason: "adapter-unavailable",
    })

    await expect(buildTwinWorkerConfig(settings)).resolves.toBeNull()
  })

  it("fails explicitly if a queued source disappears", async () => {
    ;(getTwinSource as jest.Mock).mockResolvedValue(undefined)
    const config = await buildTwinWorkerConfig(settings)

    await expect(config!.sourceLoader({ id: "missing" } as never)).rejects.toThrow("disappeared")
  })
})
