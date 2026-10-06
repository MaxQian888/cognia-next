jest.mock("@/lib/platform/detect", () => ({
  isTauri: jest.fn(() => false),
  isCapacitor: jest.fn(() => false),
  isNativeMobile: jest.fn(() => false),
}))

jest.mock("@tauri-apps/api/core", () => ({
  invoke: jest.fn(),
}))

import {
  NativeVectorStore,
  createVectorStore,
  getNativeVectorStoreSize,
  getSupportedVectorStoreProviders,
} from "./index"
import { setVectorRuntimeAdapters, resetVectorRuntimeAdaptersForTesting } from "./runtime-adapters"
import { invoke } from "@tauri-apps/api/core"

const mockIsTauri = jest.fn()
const mockInvoke = invoke as jest.MockedFunction<typeof invoke>

describe("vector package barrel", () => {
  beforeEach(() => {
    setVectorRuntimeAdapters({
      isTauri: mockIsTauri,
      createBedrockEmbeddingModel: jest.fn(),
      dispatchDocumentsIndexed: jest.fn(),
      dispatchVectorSearch: jest.fn(),
    })
    mockIsTauri.mockReset()
    mockInvoke.mockReset()
  })

  it("allows informational size queries before host bootstrap", async () => {
    resetVectorRuntimeAdaptersForTesting()
    await expect(getNativeVectorStoreSize()).resolves.toBe(0)
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it("re-exports vector store factory and provider metadata", () => {
    const store = createVectorStore({
      provider: "native",
      embeddingConfig: { provider: "openai", model: "text-embedding-3-small", dimensions: 1536 },
      embeddingApiKey: "sk-test",
      native: {},
    })

    expect(store).toBeInstanceOf(NativeVectorStore)
    expect(getSupportedVectorStoreProviders()).toContain("native")
  })

  it("returns zero size outside Tauri and invokes native size inside Tauri", async () => {
    mockIsTauri.mockReturnValue(false)
    await expect(getNativeVectorStoreSize()).resolves.toBe(0)
    expect(mockInvoke).not.toHaveBeenCalled()

    mockIsTauri.mockReturnValue(true)
    mockInvoke.mockResolvedValue(4096)
    await expect(getNativeVectorStoreSize()).resolves.toBe(4096)
    expect(mockInvoke).toHaveBeenCalledWith("vector_get_store_size", {})
  })
})
