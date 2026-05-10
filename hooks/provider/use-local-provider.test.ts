/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react"
import type { LocalServerStatus, LocalModelInfo } from "@/types/provider/local-provider"

const getStatus = jest.fn<Promise<LocalServerStatus>, []>()
const listModels = jest.fn<Promise<LocalModelInfo[]>, []>()
const createLocalProviderService = jest.fn(() => ({
  getStatus,
  listModels,
}))
const getProviderCapabilities = jest.fn(() => ({ supportsPull: true }) as never)

jest.mock("@/lib/ai/providers/local-provider-service", () => ({
  createLocalProviderService: (...args: unknown[]) => createLocalProviderService(...(args as [])),
  getProviderCapabilities: (...args: unknown[]) => getProviderCapabilities(...(args as [])),
}))

jest.mock("@/lib/ai/providers/local-providers", () => ({
  LOCAL_PROVIDER_CONFIGS: {
    ollama: { id: "ollama", label: "Ollama" },
  },
}))

import { useLocalProvider, useLocalProvidersScan } from "./use-local-provider"

const okStatus: LocalServerStatus = { connected: true } as LocalServerStatus
const oneModel: LocalModelInfo[] = [{ id: "m1", name: "m1" } as LocalModelInfo]

beforeEach(() => {
  jest.clearAllMocks()
  getStatus.mockResolvedValue(okStatus)
  listModels.mockResolvedValue(oneModel)
})

describe("useLocalProvider — initial state and refresh", () => {
  it("auto-refreshes once on mount when baseUrl is present", async () => {
    const { result } = renderHook(() =>
      useLocalProvider({ providerId: "ollama", baseUrl: "http://localhost:11434" })
    )
    await waitFor(() => expect(result.current.status).toEqual(okStatus))
    expect(result.current.models).toEqual(oneModel)
    expect(result.current.isConnected).toBe(true)
    expect(result.current.config).toEqual({ id: "ollama", label: "Ollama" })
  })

  it("skips network calls when baseUrl is absent", async () => {
    const { result } = renderHook(() => useLocalProvider({ providerId: "ollama" }))
    // wait a microtask for the scheduled timeout
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(createLocalProviderService).not.toHaveBeenCalled()
    expect(result.current.status).toBeNull()
    expect(result.current.isConnected).toBe(false)
  })

  it("captures errors from refresh in the error field", async () => {
    getStatus.mockRejectedValueOnce(new Error("boom"))
    const { result } = renderHook(() =>
      useLocalProvider({ providerId: "ollama", baseUrl: "http://x" })
    )
    await waitFor(() => expect(result.current.error).toBe("boom"))
    expect(result.current.isLoading).toBe(false)
  })

  it("stringifies non-Error rejections", async () => {
    getStatus.mockRejectedValueOnce("opaque")
    const { result } = renderHook(() =>
      useLocalProvider({ providerId: "ollama", baseUrl: "http://x" })
    )
    await waitFor(() => expect(result.current.error).toBe("opaque"))
  })
})

describe("useLocalProvider — testServer", () => {
  it("returns null and skips service when baseUrl is missing", async () => {
    const { result } = renderHook(() => useLocalProvider({ providerId: "ollama" }))
    await act(async () => {
      const ret = await result.current.testServer()
      expect(ret).toBeNull()
    })
  })

  it("updates status on success", async () => {
    const { result } = renderHook(() =>
      useLocalProvider({ providerId: "ollama", baseUrl: "http://x" })
    )
    await waitFor(() => expect(result.current.status).not.toBeNull())
    getStatus.mockResolvedValueOnce({ connected: false } as LocalServerStatus)
    await act(async () => {
      const s = await result.current.testServer()
      expect(s).toEqual({ connected: false })
    })
    expect(result.current.status).toEqual({ connected: false })
  })

  it("captures error and returns null on failure", async () => {
    const { result } = renderHook(() =>
      useLocalProvider({ providerId: "ollama", baseUrl: "http://x" })
    )
    await waitFor(() => expect(result.current.status).not.toBeNull())
    getStatus.mockRejectedValueOnce(new Error("nope"))
    let ret: LocalServerStatus | null = okStatus
    await act(async () => {
      ret = await result.current.testServer()
    })
    expect(ret).toBeNull()
    expect(result.current.error).toBe("nope")
  })
})

describe("useLocalProvider — fetchModels", () => {
  it("returns [] when baseUrl is missing", async () => {
    const { result } = renderHook(() => useLocalProvider({ providerId: "ollama" }))
    await act(async () => {
      const ret = await result.current.fetchModels()
      expect(ret).toEqual([])
    })
  })

  it("updates models on success", async () => {
    const { result } = renderHook(() =>
      useLocalProvider({ providerId: "ollama", baseUrl: "http://x" })
    )
    await waitFor(() => expect(result.current.models.length).toBe(1))
    listModels.mockResolvedValueOnce([{ id: "m2", name: "m2" } as LocalModelInfo])
    await act(async () => {
      const ret = await result.current.fetchModels()
      expect(ret).toEqual([{ id: "m2", name: "m2" }])
    })
    expect(result.current.models).toEqual([{ id: "m2", name: "m2" }])
  })

  it("captures error and returns [] on failure", async () => {
    const { result } = renderHook(() =>
      useLocalProvider({ providerId: "ollama", baseUrl: "http://x" })
    )
    await waitFor(() => expect(result.current.models.length).toBe(1))
    listModels.mockRejectedValueOnce("opaque")
    let ret: LocalModelInfo[] = oneModel
    await act(async () => {
      ret = await result.current.fetchModels()
    })
    expect(ret).toEqual([])
    expect(result.current.error).toBe("opaque")
  })
})

describe("useLocalProvider — destructive ops (deferred)", () => {
  it("pullModel records a deferred error in pullStates", async () => {
    const { result } = renderHook(() =>
      useLocalProvider({ providerId: "ollama", baseUrl: "http://x" })
    )
    await waitFor(() => expect(result.current.status).not.toBeNull())
    await act(async () => {
      await result.current.pullModel("m1")
    })
    expect(result.current.error).toContain("Model pull")
    expect(result.current.pullStates.get("m1")).toEqual({
      modelName: "m1",
      status: "error",
      percentage: 0,
      error: "Native bindings deferred",
      isActive: false,
    })
    // isPulling stays false since deferred entry has isActive: false
    expect(result.current.isPulling).toBe(false)
  })

  it("deleteModel uses the same deferred path", async () => {
    const { result } = renderHook(() =>
      useLocalProvider({ providerId: "ollama", baseUrl: "http://x" })
    )
    await waitFor(() => expect(result.current.status).not.toBeNull())
    await act(async () => {
      await result.current.deleteModel("m1")
    })
    expect(result.current.error).toContain("Model delete")
  })

  it("stopModel uses the same deferred path", async () => {
    const { result } = renderHook(() =>
      useLocalProvider({ providerId: "ollama", baseUrl: "http://x" })
    )
    await waitFor(() => expect(result.current.status).not.toBeNull())
    await act(async () => {
      await result.current.stopModel("m1")
    })
    expect(result.current.error).toContain("Model stop")
  })

  it("cancelPull marks an existing pull state cancelled", async () => {
    const { result } = renderHook(() =>
      useLocalProvider({ providerId: "ollama", baseUrl: "http://x" })
    )
    await waitFor(() => expect(result.current.status).not.toBeNull())
    // Seed state via pullModel first
    await act(async () => {
      await result.current.pullModel("m1")
    })
    await act(async () => {
      await result.current.cancelPull("m1")
    })
    expect(result.current.pullStates.get("m1")?.status).toBe("cancelled")
    expect(result.current.pullStates.get("m1")?.isActive).toBe(false)
  })

  it("cancelPull seeds a new entry when none exists", async () => {
    const { result } = renderHook(() =>
      useLocalProvider({ providerId: "ollama", baseUrl: "http://x" })
    )
    await waitFor(() => expect(result.current.status).not.toBeNull())
    await act(async () => {
      await result.current.cancelPull("never-pulled")
    })
    expect(result.current.pullStates.get("never-pulled")?.status).toBe("cancelled")
  })
})

describe("useLocalProvider — autoRefresh interval", () => {
  it("repeats refresh on the configured interval", async () => {
    jest.useFakeTimers()
    try {
      renderHook(() =>
        useLocalProvider({
          providerId: "ollama",
          baseUrl: "http://x",
          autoRefresh: true,
          refreshInterval: 1000,
        })
      )
      // Initial timeout(0) + interval ticks
      await act(async () => {
        jest.advanceTimersByTime(0)
        await Promise.resolve()
      })
      expect(getStatus).toHaveBeenCalledTimes(1)
      await act(async () => {
        jest.advanceTimersByTime(1000)
        await Promise.resolve()
      })
      expect(getStatus.mock.calls.length).toBeGreaterThanOrEqual(2)
    } finally {
      jest.useRealTimers()
    }
  })
})

describe("useLocalProvidersScan", () => {
  it("returns the inert stub shape", () => {
    const { result } = renderHook(() => useLocalProvidersScan())
    expect(result.current.detected.size).toBe(0)
    expect(result.current.results.size).toBe(0)
    expect(result.current.isScanning).toBe(false)
    expect(result.current.error).toBeNull()
    return expect(result.current.scan()).resolves.toBeUndefined()
  })
})
