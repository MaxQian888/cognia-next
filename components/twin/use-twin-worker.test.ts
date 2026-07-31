/**
 * @jest-environment jsdom
 *
 * Unit coverage for the twin worker hooks. Stubs `dexie-react-hooks` and the
 * vector-store / LLM client factories so we can drive the hooks through their
 * gate paths (no twin, disabled, incomplete config) and assert that the
 * BACKGROUND worker — not the panel status hook — is the one that actually
 * spins up a job-worker loop.
 */

import { renderHook } from "@testing-library/react"

const observeMock = jest.fn()
const stopMock = jest.fn()
const startWorkerMock = jest.fn((..._args: unknown[]) => ({ stop: stopMock }))

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: <T>(query: () => Promise<T> | T, _deps?: unknown[], initial?: T): T => {
    const result = observeMock()
    return (result ?? initial) as T
  },
}))

jest.mock("@/lib/db/twin-runtime-settings", () => ({
  observeTwinRuntimeSettings: () => Promise.resolve({}),
}))

const getTwinSourceMock = jest.fn()
jest.mock("@/lib/db/twin-sources", () => ({
  getTwinSource: (...args: unknown[]) => getTwinSourceMock(...args),
}))

jest.mock("@/lib/twin/job-worker", () => ({
  startJobWorker: (...args: unknown[]) => startWorkerMock(...args),
}))

jest.mock("@cognia/vector/store", () => ({
  createVectorStore: jest.fn(() => ({ kind: "stub-store" })),
}))

jest.mock("@/lib/twin/distill", () => ({
  createAnthropicLlmClient: jest.fn(() => ({ kind: "stub-llm" })),
}))

import { DEFAULT_TWIN_RUNTIME_SETTINGS } from "@/types/twin"
import { createVectorStore } from "@cognia/vector/store"
import {
  buildTwinWorkerConfig,
  isTwinWorkerConfigComplete,
  useBackgroundTwinWorker,
  useTwinWorkerStatus,
} from "./use-twin-worker"

const COMPLETE_SETTINGS = {
  ...DEFAULT_TWIN_RUNTIME_SETTINGS,
  workerEnabled: true,
  embedding: { ...DEFAULT_TWIN_RUNTIME_SETTINGS.embedding, apiKey: "embed-key" },
  llm: { ...DEFAULT_TWIN_RUNTIME_SETTINGS.llm, apiKey: "llm-key" },
  storage: {
    ...DEFAULT_TWIN_RUNTIME_SETTINGS.storage,
    vectorBackend: "qdrant" as const,
    qdrant: { url: "http://localhost:6333" },
  },
}

beforeEach(() => {
  observeMock.mockReset()
  startWorkerMock.mockClear()
  stopMock.mockReset()
  getTwinSourceMock.mockReset()
  ;(createVectorStore as jest.Mock).mockReset()
  ;(createVectorStore as jest.Mock).mockReturnValue({ kind: "stub-store" })
})

describe("buildTwinWorkerConfig", () => {
  it("returns null when the worker is disabled", () => {
    expect(buildTwinWorkerConfig({ ...COMPLETE_SETTINGS, workerEnabled: false })).toBeNull()
  })

  it("returns null when the embedding apiKey is missing", () => {
    expect(
      buildTwinWorkerConfig({
        ...COMPLETE_SETTINGS,
        embedding: { ...COMPLETE_SETTINGS.embedding, apiKey: "" },
      })
    ).toBeNull()
  })

  it("returns null when the llm apiKey is missing", () => {
    expect(
      buildTwinWorkerConfig({ ...COMPLETE_SETTINGS, llm: { ...COMPLETE_SETTINGS.llm, apiKey: "" } })
    ).toBeNull()
  })

  it("returns a complete config when everything is set", () => {
    const config = buildTwinWorkerConfig(COMPLETE_SETTINGS)
    expect(config).not.toBeNull()
    expect(config?.store).toBeDefined()
    expect(config?.llm).toBeDefined()
    expect(config?.sourceLoader).toBeInstanceOf(Function)
    expect(config?.vectorBackend).toBe("qdrant")
  })

  it("carries extraNameHints into the worker config", () => {
    const config = buildTwinWorkerConfig({
      ...COMPLETE_SETTINGS,
      extraNameHints: ["Alice Zhang", "张伟"],
    })
    expect(config?.nameHints).toEqual(["Alice Zhang", "张伟"])
  })

  it("returns null when the vector-store client cannot be constructed", () => {
    ;(createVectorStore as jest.Mock).mockImplementationOnce(() => {
      throw new Error("bad endpoint")
    })
    expect(buildTwinWorkerConfig(COMPLETE_SETTINGS)).toBeNull()
  })

  it.each([
    ["pinecone", { pinecone: { apiKey: "pc", indexName: "idx", namespace: "ns" } }],
    ["weaviate", { weaviate: { url: "http://w" } }],
    ["milvus", { milvus: { address: "localhost:19530", token: "t", ssl: false } }],
    ["chroma", { chroma: { mode: "server" as const, serverUrl: "http://c" } }],
  ])("builds a config for the %s backend", (backend, extra) => {
    const config = buildTwinWorkerConfig({
      ...COMPLETE_SETTINGS,
      storage: {
        ...COMPLETE_SETTINGS.storage,
        vectorBackend: backend as never,
        ...(extra as object),
      },
    })
    expect(config).not.toBeNull()
    expect(config?.vectorBackend).toBe(backend)
  })

  it("returns null for an unsupported vector backend", () => {
    const config = buildTwinWorkerConfig({
      ...COMPLETE_SETTINGS,
      storage: { ...COMPLETE_SETTINGS.storage, vectorBackend: "native" as never },
    })
    expect(config).toBeNull()
  })

  it("returns null when a selected backend is missing its connection fields", () => {
    const config = buildTwinWorkerConfig({
      ...COMPLETE_SETTINGS,
      storage: { ...COMPLETE_SETTINGS.storage, vectorBackend: "pinecone" as never },
    })
    expect(config).toBeNull()
  })
})

describe("buildTwinWorkerConfig sourceLoader", () => {
  it("materialises a TwinSource into a RawSource via getTwinSource", async () => {
    getTwinSourceMock.mockResolvedValue({
      id: "src1",
      title: "doc.md",
      format: "markdown",
      source: "# body",
    })
    const config = buildTwinWorkerConfig(COMPLETE_SETTINGS)
    const raw = await config!.sourceLoader({ id: "src1" } as never)
    expect(raw).toEqual({ id: "src1", filename: "doc.md", format: "markdown", text: "# body" })
  })

  it("emits persisted speakers as baseMetadata so redaction can seed nameHints", async () => {
    getTwinSourceMock.mockResolvedValue({
      id: "src2",
      title: "chat.md",
      format: "markdown",
      source: "### 张伟\nhello",
      speakers: ["张伟", "Alice Zhang"],
    })
    const config = buildTwinWorkerConfig(COMPLETE_SETTINGS)
    const raw = await config!.sourceLoader({ id: "src2" } as never)
    expect(raw.baseMetadata).toEqual({ speakers: ["张伟", "Alice Zhang"] })
  })

  it("throws when the source disappeared mid-load", async () => {
    getTwinSourceMock.mockResolvedValue(undefined)
    const config = buildTwinWorkerConfig(COMPLETE_SETTINGS)
    await expect(config!.sourceLoader({ id: "gone" } as never)).rejects.toThrow("disappeared")
  })
})

describe("isTwinWorkerConfigComplete", () => {
  it("is false when disabled and true when fully configured", () => {
    expect(isTwinWorkerConfigComplete({ ...COMPLETE_SETTINGS, workerEnabled: false })).toBe(false)
    expect(isTwinWorkerConfigComplete(COMPLETE_SETTINGS)).toBe(true)
  })
})

describe("useBackgroundTwinWorker", () => {
  it("starts an all-twins worker (no twinId scope) when fully configured", () => {
    observeMock.mockReturnValue(COMPLETE_SETTINGS)
    const { result } = renderHook(() => useBackgroundTwinWorker())
    expect(result.current.active).toBe(true)
    expect(startWorkerMock).toHaveBeenCalledTimes(1)
    // All-twins: only the config is passed; the twinId scope arg is absent.
    expect(startWorkerMock.mock.calls[0][1]).toBeUndefined()
  })

  it("does not start a worker when disabled", () => {
    observeMock.mockReturnValue({ ...COMPLETE_SETTINGS, workerEnabled: false })
    const { result } = renderHook(() => useBackgroundTwinWorker())
    expect(result.current.active).toBe(false)
    expect(result.current.reasonKey).toBe("disabled")
    expect(startWorkerMock).not.toHaveBeenCalled()
  })

  it("does not start a worker when the config is incomplete", () => {
    observeMock.mockReturnValue({
      ...COMPLETE_SETTINGS,
      embedding: { ...COMPLETE_SETTINGS.embedding, apiKey: "" },
    })
    const { result } = renderHook(() => useBackgroundTwinWorker())
    expect(result.current.active).toBe(false)
    expect(result.current.reasonKey).toBe("incompleteConfig")
    expect(startWorkerMock).not.toHaveBeenCalled()
  })

  it("stops the worker on unmount", () => {
    observeMock.mockReturnValue(COMPLETE_SETTINGS)
    const { unmount } = renderHook(() => useBackgroundTwinWorker())
    expect(startWorkerMock).toHaveBeenCalledTimes(1)
    unmount()
    expect(stopMock).toHaveBeenCalledTimes(1)
  })
})

describe("useTwinWorkerStatus", () => {
  it("never starts a worker — it is status-only", () => {
    observeMock.mockReturnValue(COMPLETE_SETTINGS)
    const { result } = renderHook(() => useTwinWorkerStatus("twin_alice"))
    expect(result.current.active).toBe(true)
    expect(startWorkerMock).not.toHaveBeenCalled()
  })

  it("returns noTwinSelected when twinId is null", () => {
    observeMock.mockReturnValue(COMPLETE_SETTINGS)
    const { result } = renderHook(() => useTwinWorkerStatus(null))
    expect(result.current.active).toBe(false)
    expect(result.current.reasonKey).toBe("noTwinSelected")
  })

  it("returns disabled when workerEnabled is false", () => {
    observeMock.mockReturnValue({ ...COMPLETE_SETTINGS, workerEnabled: false })
    const { result } = renderHook(() => useTwinWorkerStatus("twin_alice"))
    expect(result.current.active).toBe(false)
    expect(result.current.reasonKey).toBe("disabled")
  })

  it("returns incompleteConfig when storage config is missing", () => {
    observeMock.mockReturnValue({
      ...COMPLETE_SETTINGS,
      embedding: { ...COMPLETE_SETTINGS.embedding, apiKey: "" },
    })
    const { result } = renderHook(() => useTwinWorkerStatus("twin_alice"))
    expect(result.current.active).toBe(false)
    expect(result.current.reasonKey).toBe("incompleteConfig")
  })
})
