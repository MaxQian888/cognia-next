/**
 * @jest-environment jsdom
 *
 * Unit coverage for `useTwinWorker`. Stubs `dexie-react-hooks` and the
 * vector-store / LLM client factories so we can drive the hook through
 * its three gate paths (no twin, disabled, incomplete config).
 */

import { renderHook } from "@testing-library/react"

const observeMock = jest.fn()
const startWorkerMock = jest.fn((..._args: unknown[]) => ({ stop: jest.fn() }))

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: <T>(query: () => Promise<T> | T, _deps?: unknown[], initial?: T): T => {
    const result = observeMock()
    return (result ?? initial) as T
  },
}))

jest.mock("@/lib/db/twin-runtime-settings", () => ({
  observeTwinRuntimeSettings: () => Promise.resolve({}),
}))

jest.mock("@/lib/twin/job-worker", () => ({
  startJobWorker: (...args: unknown[]) => startWorkerMock(...args),
}))

jest.mock("@/lib/vector/store", () => ({
  createVectorStore: jest.fn(() => ({ kind: "stub-store" })),
}))

jest.mock("@/lib/twin/distill", () => ({
  createAnthropicLlmClient: jest.fn(() => ({ kind: "stub-llm" })),
}))

import { DEFAULT_TWIN_RUNTIME_SETTINGS } from "@/types/twin"
import { useTwinWorker } from "./use-twin-worker"

beforeEach(() => {
  observeMock.mockReset()
  startWorkerMock.mockClear()
})

describe("useTwinWorker", () => {
  it("returns inactive + noTwinSelected when twinId is null", () => {
    observeMock.mockReturnValue({ ...DEFAULT_TWIN_RUNTIME_SETTINGS, workerEnabled: true })
    const { result } = renderHook(() => useTwinWorker(null))
    expect(result.current.active).toBe(false)
    expect(result.current.reasonKey).toBe("noTwinSelected")
  })

  it("returns inactive + disabled when workerEnabled is false", () => {
    observeMock.mockReturnValue({
      ...DEFAULT_TWIN_RUNTIME_SETTINGS,
      workerEnabled: false,
    })
    const { result } = renderHook(() => useTwinWorker("twin_alice"))
    expect(result.current.active).toBe(false)
    expect(result.current.reasonKey).toBe("disabled")
  })

  it("returns inactive + incompleteConfig when storage config is missing", () => {
    observeMock.mockReturnValue({
      ...DEFAULT_TWIN_RUNTIME_SETTINGS,
      workerEnabled: true,
      embedding: { ...DEFAULT_TWIN_RUNTIME_SETTINGS.embedding, apiKey: "" },
    })
    const { result } = renderHook(() => useTwinWorker("twin_alice"))
    expect(result.current.active).toBe(false)
    expect(result.current.reasonKey).toBe("incompleteConfig")
  })

  it("returns active when everything is configured", () => {
    observeMock.mockReturnValue({
      ...DEFAULT_TWIN_RUNTIME_SETTINGS,
      workerEnabled: true,
      embedding: {
        ...DEFAULT_TWIN_RUNTIME_SETTINGS.embedding,
        apiKey: "embed-key",
      },
      llm: { ...DEFAULT_TWIN_RUNTIME_SETTINGS.llm, apiKey: "llm-key" },
      storage: {
        ...DEFAULT_TWIN_RUNTIME_SETTINGS.storage,
        vectorBackend: "qdrant",
        qdrant: { url: "http://localhost:6333" },
      },
    })
    const { result } = renderHook(() => useTwinWorker("twin_alice"))
    expect(result.current.active).toBe(true)
    expect(result.current.reasonKey).toBeUndefined()
    expect(startWorkerMock).toHaveBeenCalled()
  })
})
