/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react"
import type { LocalServerStatus, LocalModelInfo } from "@cognia/provider-types/local-provider"

const getStatus = jest.fn<Promise<LocalServerStatus>, []>()
const listModels = jest.fn<Promise<LocalModelInfo[]>, []>()
const pullModel = jest.fn()
const deleteModel = jest.fn()
const stopModel = jest.fn()
const createLocalProviderService = jest.fn(() => ({
  getStatus,
  listModels,
  pullModel,
  deleteModel,
  stopModel,
}))
const getProviderCapabilities = jest.fn(() => ({ supportsPull: true }) as never)
const checkAllProvidersInstallation = jest.fn()

jest.mock("@cognia/provider-core/providers/local-provider-service", () => ({
  createLocalProviderService: (...args: unknown[]) => createLocalProviderService(...(args as [])),
  getProviderCapabilities: (...args: unknown[]) => getProviderCapabilities(...(args as [])),
  checkAllProvidersInstallation: (...args: unknown[]) =>
    checkAllProvidersInstallation(...(args as [])),
}))

jest.mock("@cognia/provider-core/providers/local-providers", () => ({
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
  pullModel.mockResolvedValue({ success: true, unsubscribe: jest.fn() })
  deleteModel.mockResolvedValue(true)
  stopModel.mockResolvedValue(true)
  checkAllProvidersInstallation.mockResolvedValue([])
})

describe("useLocalProvider — initial state and refresh", () => {
  it("auto-refreshes once on mount when baseUrl is present", async () => {
    const onModelsDiscovered = jest.fn()
    const { result } = renderHook(() =>
      useLocalProvider({
        providerId: "ollama",
        baseUrl: "http://localhost:11434",
        onModelsDiscovered,
      })
    )
    await waitFor(() => expect(result.current.status).toEqual(okStatus))
    expect(result.current.models).toEqual(oneModel)
    expect(result.current.isConnected).toBe(true)
    expect(result.current.config).toEqual({ id: "ollama", label: "Ollama" })
    expect(onModelsDiscovered).toHaveBeenCalledWith(oneModel)
  })

  it("pauses auto-refresh while the document is hidden and resumes on visibility", async () => {
    jest.useFakeTimers()
    let visibility: DocumentVisibilityState = "visible"
    const visibilitySpy = jest
      .spyOn(document, "visibilityState", "get")
      .mockImplementation(() => visibility)
    try {
      renderHook(() =>
        useLocalProvider({
          providerId: "ollama",
          baseUrl: "http://localhost:11434",
          autoRefresh: true,
          refreshInterval: 1000,
        })
      )
      await act(async () => {
        jest.advanceTimersByTime(0)
      })
      const afterMount = getStatus.mock.calls.length
      await act(async () => {
        jest.advanceTimersByTime(2000)
      })
      expect(getStatus.mock.calls.length).toBeGreaterThan(afterMount)

      // Hidden: the interval stops.
      visibility = "hidden"
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"))
      })
      const whileHidden = getStatus.mock.calls.length
      await act(async () => {
        jest.advanceTimersByTime(5000)
      })
      expect(getStatus.mock.calls.length).toBe(whileHidden)

      // Visible again: immediate refresh + interval resumes.
      visibility = "visible"
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"))
      })
      expect(getStatus.mock.calls.length).toBe(whileHidden + 1)
      await act(async () => {
        jest.advanceTimersByTime(1000)
      })
      expect(getStatus.mock.calls.length).toBe(whileHidden + 2)
    } finally {
      visibilitySpy.mockRestore()
      jest.useRealTimers()
    }
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
    const onModelsDiscovered = jest.fn()
    getStatus.mockRejectedValueOnce(new Error("boom"))
    const { result } = renderHook(() =>
      useLocalProvider({ providerId: "ollama", baseUrl: "http://x", onModelsDiscovered })
    )
    await waitFor(() => expect(result.current.error).toBe("boom"))
    expect(result.current.isLoading).toBe(false)
    expect(onModelsDiscovered).not.toHaveBeenCalled()
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

/**
 * These replace three tests that pinned the ops as dormant — asserting
 * `error: "Native bindings deferred"` and an inert `pullStates` entry. They
 * were the "test pin" axis of the repo's intentional-dormancy rule, and were
 * correct while the ops really were stubs. The stubs are gone: the service
 * these now call had a complete HTTP implementation the whole time, and the
 * native bindings they were "deferred" pending were never coming.
 */
describe("useLocalProvider — destructive ops", () => {
  it("pullModel drives the real service and completes the pull state", async () => {
    pullModel.mockResolvedValue({ success: true, unsubscribe: jest.fn() })
    const { result } = renderHook(() =>
      useLocalProvider({ providerId: "ollama", baseUrl: "http://x" })
    )
    await waitFor(() => expect(result.current.status).not.toBeNull())

    await act(async () => {
      await result.current.pullModel("m1")
    })

    expect(pullModel).toHaveBeenCalledWith(
      "m1",
      expect.objectContaining({ onProgress: expect.any(Function) })
    )
    expect(result.current.error).toBeNull()
    expect(result.current.pullStates.get("m1")).toMatchObject({
      modelName: "m1",
      status: "completed",
      percentage: 100,
      isActive: false,
      indeterminate: false,
    })
    expect(result.current.isPulling).toBe(false)
  })

  /**
   * Ollama's opening lines carry no byte counts, so any percentage shown then
   * would be fabricated. The pull must stay indeterminate until real totals
   * arrive, and only then resolve to a number.
   */
  it("pullModel stays indeterminate until the server sends byte counts", async () => {
    let emit: ((p: unknown) => void) | undefined
    pullModel.mockImplementation(
      async (_name: string, opts: { onProgress: (p: unknown) => void }) => {
        emit = opts.onProgress
        emit({ status: "pulling manifest" })
        return { success: true, unsubscribe: jest.fn() }
      }
    )
    const { result } = renderHook(() =>
      useLocalProvider({ providerId: "ollama", baseUrl: "http://x" })
    )
    await waitFor(() => expect(result.current.status).not.toBeNull())

    await act(async () => {
      const pending = result.current.pullModel("m1")
      // A totals-bearing line lands mid-flight.
      emit?.({ status: "downloading", completed: 25, total: 100 })
      await pending
    })

    // The final state reflects the completed pull; the interesting assertion is
    // that the mid-flight percentage came from the server, not from thin air.
    const state = result.current.pullStates.get("m1")
    expect(state?.status).toBe("completed")
    expect(state?.indeterminate).toBe(false)
  })

  /**
   * A progress event mid-flight carries a digest and a computed percentage
   * onto the row. The pull is held open (unresolved) so the row stays in its
   * "pulling" state long enough to observe — a resolved handle would flip it to
   * "completed" (100%) before we could read the intermediate value.
   */
  it("projects digest and percentage from a totals-bearing progress line", async () => {
    let emit: ((p: unknown) => void) | undefined
    let resolvePull: ((v: { success: boolean; unsubscribe: () => void }) => void) | undefined
    pullModel.mockImplementation(async (_n: string, opts: { onProgress: (p: unknown) => void }) => {
      emit = opts.onProgress
      return new Promise((r) => (resolvePull = r))
    })
    const { result } = renderHook(() =>
      useLocalProvider({ providerId: "ollama", baseUrl: "http://x" })
    )
    await waitFor(() => expect(result.current.status).not.toBeNull())

    let pending: Promise<void>
    await act(async () => {
      pending = result.current.pullModel("m1")
      await Promise.resolve()
    })
    await act(async () => {
      emit?.({ status: "downloading", completed: 30, total: 120, digest: "sha256:abc" })
    })

    // Read the mid-flight row, before the pull resolves.
    expect(result.current.pullStates.get("m1")?.percentage).toBe(25) // 30 / 120
    expect(result.current.pullStates.get("m1")?.digest).toBe("sha256:abc")
    expect(result.current.pullStates.get("m1")?.indeterminate).toBe(false)

    await act(async () => {
      resolvePull?.({ success: true, unsubscribe: jest.fn() })
      await pending
    })
  })

  /**
   * A progress event that fires AFTER the user dismissed the pull must not
   * resurrect its row — the late-event guard.
   */
  it("ignores a progress event for a pull that is no longer active", async () => {
    let emit: ((p: unknown) => void) | undefined
    pullModel.mockImplementation(async (_n: string, opts: { onProgress: (p: unknown) => void }) => {
      emit = opts.onProgress
      return { success: true, unsubscribe: jest.fn() }
    })
    const { result } = renderHook(() =>
      useLocalProvider({ providerId: "ollama", baseUrl: "http://x" })
    )
    await waitFor(() => expect(result.current.status).not.toBeNull())

    await act(async () => {
      await result.current.pullModel("m1")
    })
    // Pull has completed (isActive false). A straggler event must be dropped.
    await act(async () => {
      emit?.({ status: "downloading", completed: 5, total: 10 })
    })
    expect(result.current.pullStates.get("m1")?.status).toBe("completed")
  })

  it("marks the pull row errored when the service reports a non-success handle", async () => {
    pullModel.mockResolvedValue({ success: false, unsubscribe: jest.fn() })
    const { result } = renderHook(() =>
      useLocalProvider({ providerId: "ollama", baseUrl: "http://x" })
    )
    await waitFor(() => expect(result.current.status).not.toBeNull())

    await act(async () => {
      await result.current.pullModel("m1")
    })

    expect(result.current.pullStates.get("m1")).toMatchObject({
      status: "error",
      isActive: false,
      error: "pull-failed",
    })
  })

  it("pullModel / deleteModel / stopModel no-op without a baseUrl", async () => {
    const { result } = renderHook(() => useLocalProvider({ providerId: "ollama" }))

    await act(async () => {
      await result.current.pullModel("m1")
      await result.current.deleteModel("m1")
      await result.current.stopModel("m1")
    })

    expect(pullModel).not.toHaveBeenCalled()
    expect(deleteModel).not.toHaveBeenCalled()
    expect(stopModel).not.toHaveBeenCalled()
    expect(result.current.pullStates.size).toBe(0)
  })

  it("deleteModel surfaces a thrown service error", async () => {
    deleteModel.mockRejectedValue(new Error("disk busy"))
    const { result } = renderHook(() =>
      useLocalProvider({ providerId: "ollama", baseUrl: "http://x" })
    )
    await waitFor(() => expect(result.current.status).not.toBeNull())

    await act(async () => {
      await result.current.deleteModel("m1")
    })

    expect(result.current.error).toBe("disk busy")
  })

  it("stopModel surfaces a thrown service error", async () => {
    stopModel.mockRejectedValue(new Error("still loaded"))
    const { result } = renderHook(() =>
      useLocalProvider({ providerId: "ollama", baseUrl: "http://x" })
    )
    await waitFor(() => expect(result.current.status).not.toBeNull())

    await act(async () => {
      await result.current.stopModel("m1")
    })

    expect(result.current.error).toBe("still loaded")
  })

  it("deleteModel calls the service and refreshes the list", async () => {
    deleteModel.mockResolvedValue(true)
    const { result } = renderHook(() =>
      useLocalProvider({ providerId: "ollama", baseUrl: "http://x" })
    )
    await waitFor(() => expect(result.current.status).not.toBeNull())

    await act(async () => {
      await result.current.deleteModel("m1")
    })

    expect(deleteModel).toHaveBeenCalledWith("m1")
    expect(result.current.error).toBeNull()
  })

  /**
   * A stable CODE, not a sentence. This hook has no `t()` and its `error` is
   * rendered verbatim by the component, so an English string here would ship
   * untranslatable text to every locale; the component maps the code to `t()`.
   */
  it("surfaces an unsupported provider as a translatable code, not authored English", async () => {
    deleteModel.mockResolvedValue(false)
    const { result } = renderHook(() =>
      useLocalProvider({ providerId: "ollama", baseUrl: "http://x" })
    )
    await waitFor(() => expect(result.current.status).not.toBeNull())

    await act(async () => {
      await result.current.deleteModel("m1")
    })

    expect(result.current.error).toBe("delete-unsupported")
  })

  it("surfaces an unsupported stop as a translatable code too", async () => {
    stopModel.mockResolvedValue(false)
    const { result } = renderHook(() =>
      useLocalProvider({ providerId: "ollama", baseUrl: "http://x" })
    )
    await waitFor(() => expect(result.current.status).not.toBeNull())

    await act(async () => {
      await result.current.stopModel("m1")
    })

    expect(result.current.error).toBe("stop-unsupported")
  })

  it("stopModel calls the service", async () => {
    stopModel.mockResolvedValue(true)
    const { result } = renderHook(() =>
      useLocalProvider({ providerId: "ollama", baseUrl: "http://x" })
    )
    await waitFor(() => expect(result.current.status).not.toBeNull())

    await act(async () => {
      await result.current.stopModel("m1")
    })

    expect(stopModel).toHaveBeenCalledWith("m1")
    expect(result.current.error).toBeNull()
  })

  it("pullModel reports a thrown service error", async () => {
    pullModel.mockRejectedValue(new Error("registry unreachable"))
    const { result } = renderHook(() =>
      useLocalProvider({ providerId: "ollama", baseUrl: "http://x" })
    )
    await waitFor(() => expect(result.current.status).not.toBeNull())

    await act(async () => {
      await result.current.pullModel("m1")
    })

    expect(result.current.error).toBe("registry unreachable")
    expect(result.current.pullStates.get("m1")).toMatchObject({
      status: "error",
      isActive: false,
    })
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
  it("starts empty before a scan has run", () => {
    const { result } = renderHook(() => useLocalProvidersScan())
    expect(result.current.detected.size).toBe(0)
    expect(result.current.isScanning).toBe(false)
    expect(result.current.error).toBeNull()
  })

  /**
   * Replaces a test named "returns the inert stub shape", which asserted the
   * scan resolved to `undefined` having done nothing. This hook is the ONLY
   * data source behind the Scan button in LocalProviderSettings, so that stub
   * meant the button was decorative.
   */
  it("actually probes every provider and projects the results", async () => {
    checkAllProvidersInstallation.mockResolvedValue([
      { providerId: "ollama", running: true, installed: true, version: "0.6.1" },
      { providerId: "lmstudio", running: false, installed: undefined, error: "ECONNREFUSED" },
    ])
    const { result } = renderHook(() => useLocalProvidersScan())

    await act(async () => {
      await result.current.scan()
    })

    expect(checkAllProvidersInstallation).toHaveBeenCalled()
    expect(result.current.detected.get("ollama")).toMatchObject({
      connected: true,
      version: "0.6.1",
    })
    expect(result.current.detected.get("lmstudio")).toMatchObject({ connected: false })
  })

  it("threads the caller's baseUrls through so a moved port is probed, not the default", async () => {
    checkAllProvidersInstallation.mockResolvedValue([])
    const { result } = renderHook(() => useLocalProvidersScan())

    await act(async () => {
      await result.current.scan({ ollama: "http://127.0.0.1:11500" })
    })

    expect(checkAllProvidersInstallation).toHaveBeenCalledWith({
      ollama: "http://127.0.0.1:11500",
    })
  })

  it("records a scan failure instead of throwing at the caller", async () => {
    checkAllProvidersInstallation.mockRejectedValue(new Error("probe blew up"))
    const { result } = renderHook(() => useLocalProvidersScan())

    await act(async () => {
      await result.current.scan()
    })

    expect(result.current.error).toBe("probe blew up")
    expect(result.current.isScanning).toBe(false)
  })

  it("ignores an overlapping scan while one is in flight", async () => {
    let release: (() => void) | undefined
    checkAllProvidersInstallation.mockImplementation(
      () => new Promise((resolve) => (release = () => resolve([])))
    )
    const { result } = renderHook(() => useLocalProvidersScan())

    await act(async () => {
      void result.current.scan()
      void result.current.scan()
      release?.()
    })

    expect(checkAllProvidersInstallation).toHaveBeenCalledTimes(1)
  })

  it("keeps a stable scan identity across re-renders (guards the re-scan loop)", () => {
    // Consumers feed `scan` into useCallback→useEffect deps; a fresh reference
    // each render would re-trigger the mount scan forever.
    const { result, rerender } = renderHook(() => useLocalProvidersScan())
    const first = result.current
    rerender()
    expect(result.current.scan).toBe(first.scan)
    // `detected`/`results` are state now, so they hold identity until a scan
    // replaces them — which is what the effect deps need.
    expect(result.current.detected).toBe(first.detected)
    expect(result.current.results).toBe(first.results)
  })
})
