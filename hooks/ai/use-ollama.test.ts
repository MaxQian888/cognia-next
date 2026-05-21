/**
 * @jest-environment jsdom
 *
 * Tests for `useOllama` — the minimal hook that backs the Ollama model
 * manager. Covers the happy /api/tags path, the optional /api/version
 * and /api/ps probes, network failure handling, autoRefresh polling,
 * and the four "native binding deferred" mutation stubs (pull, cancelPull,
 * deleteModel, stopModel).
 */

import { act, renderHook, waitFor } from "@testing-library/react"

import { useOllama } from "./use-ollama"

type FetchMock = jest.Mock<Promise<Response>, [RequestInfo | URL, RequestInit?]>

function jsonResponse(body: unknown, init: ResponseInit = { status: 200 }): Response {
  return {
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    json: async () => body,
  } as unknown as Response
}

function setupFetch(handlers: Record<string, () => Promise<Response>>): FetchMock {
  const mock = jest.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : (input as URL).toString()
    for (const [pattern, handler] of Object.entries(handlers)) {
      if (url.includes(pattern)) {
        return handler()
      }
    }
    throw new Error(`No handler for ${url}`)
  })
  ;(globalThis as unknown as { fetch: FetchMock }).fetch = mock
  return mock
}

beforeEach(() => {
  jest.useRealTimers()
})

afterEach(() => {
  jest.useRealTimers()
})

describe("useOllama — refresh()", () => {
  it("populates models from /api/tags and resolves connected status", async () => {
    setupFetch({
      "/api/tags": async () => jsonResponse({ models: [{ name: "llama3" }, { name: "qwen2.5" }] }),
      "/api/version": async () => jsonResponse({ version: "0.5.4" }),
      "/api/ps": async () => jsonResponse({ models: [{ name: "llama3" }] }),
    })
    const { result } = renderHook(() => useOllama({ baseUrl: "http://127.0.0.1:11434" }))
    await waitFor(() => expect(result.current.models.length).toBe(2))
    expect(result.current.isConnected).toBe(true)
    expect(result.current.status?.state).toBe("connected")
    expect(result.current.status?.version).toBe("0.5.4")
    expect(result.current.status?.models_count).toBe(2)
    expect(result.current.runningModels.map((m) => m.name)).toEqual(["llama3"])
    expect(result.current.error).toBeNull()
  })

  it("strips trailing slash from baseUrl before composing endpoints", async () => {
    const fetchMock = setupFetch({
      "/api/tags": async () => jsonResponse({ models: [] }),
      "/api/version": async () => jsonResponse({}),
      "/api/ps": async () => jsonResponse({ models: [] }),
    })
    renderHook(() => useOllama({ baseUrl: "http://127.0.0.1:11434/" }))
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((c) => String(c[0]))
      expect(urls.some((u) => u === "http://127.0.0.1:11434/api/tags")).toBe(true)
    })
  })

  it("treats version + ps probes as best-effort — failures don't tank the status", async () => {
    setupFetch({
      "/api/tags": async () => jsonResponse({ models: [{ name: "llama3" }] }),
      "/api/version": async () => {
        throw new Error("offline")
      },
      "/api/ps": async () => jsonResponse({}, { status: 404 }),
    })
    const { result } = renderHook(() => useOllama({ baseUrl: "http://127.0.0.1:11434" }))
    await waitFor(() => expect(result.current.isConnected).toBe(true))
    expect(result.current.status?.version).toBeUndefined()
    expect(result.current.runningModels).toEqual([])
  })

  it("surfaces a network failure as state=error + non-null error message", async () => {
    setupFetch({
      "/api/tags": async () => {
        throw new Error("ECONNREFUSED 127.0.0.1:11434")
      },
    })
    const { result } = renderHook(() => useOllama({ baseUrl: "http://127.0.0.1:11434" }))
    await waitFor(() => expect(result.current.status?.state).toBe("error"))
    expect(result.current.isConnected).toBe(false)
    expect(result.current.error).toMatch(/ECONNREFUSED/)
  })

  it("flips status to error when /api/tags returns a 5xx response", async () => {
    setupFetch({
      "/api/tags": async () => jsonResponse({}, { status: 503 }),
    })
    const { result } = renderHook(() => useOllama({ baseUrl: "http://127.0.0.1:11434" }))
    await waitFor(() => expect(result.current.error).toMatch(/503/))
    expect(result.current.status?.state).toBe("error")
  })

  it("does nothing when baseUrl is empty (avoids hitting the network)", async () => {
    const fetchMock = setupFetch({})
    const { result } = renderHook(() => useOllama({ baseUrl: "" }))
    await act(async () => {
      await result.current.refresh()
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.current.status).toBeNull()
  })
})

describe("useOllama — autoRefresh interval", () => {
  it("re-polls /api/tags on the configured interval when autoRefresh is on", async () => {
    const fetchMock = setupFetch({
      "/api/tags": async () => jsonResponse({ models: [] }),
      "/api/version": async () => jsonResponse({}),
      "/api/ps": async () => jsonResponse({ models: [] }),
    })
    jest.useFakeTimers()
    const { unmount } = renderHook(() =>
      useOllama({ baseUrl: "http://127.0.0.1:11434", autoRefresh: true, refreshInterval: 1000 })
    )
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0)
    })
    const initialTags = fetchMock.mock.calls.filter((c) =>
      String(c[0]).endsWith("/api/tags")
    ).length
    expect(initialTags).toBeGreaterThanOrEqual(1)
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1100)
    })
    const tagsAfter = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/api/tags")).length
    expect(tagsAfter).toBeGreaterThan(initialTags)
    unmount()
  })
})

describe("useOllama — native-binding-deferred mutations", () => {
  beforeEach(() => {
    setupFetch({
      "/api/tags": async () => jsonResponse({ models: [] }),
      "/api/version": async () => jsonResponse({}),
      "/api/ps": async () => jsonResponse({ models: [] }),
    })
  })

  it("pullModel records a `pulling`-failed state and writes a 'native deferred' error", async () => {
    const { result } = renderHook(() => useOllama({ baseUrl: "http://127.0.0.1:11434" }))
    await waitFor(() => expect(result.current.status?.state).toBe("connected"))
    await act(async () => {
      await result.current.pullModel("llama3")
    })
    expect(result.current.pullStates.get("llama3")?.status).toBe("error")
    expect(result.current.pullStates.get("llama3")?.error).toBe("Native pull deferred")
    expect(result.current.pullStates.get("llama3")?.isActive).toBe(false)
    expect(result.current.isPulling).toBe(false)
    expect(result.current.error).toMatch(/pullModel/)
  })

  it("cancelPull seeds a 'cancelled' entry when no prior pull existed", async () => {
    const { result } = renderHook(() => useOllama({ baseUrl: "http://127.0.0.1:11434" }))
    await act(async () => {
      await result.current.cancelPull("never-pulled")
    })
    expect(result.current.pullStates.get("never-pulled")?.status).toBe("cancelled")
    expect(result.current.pullStates.get("never-pulled")?.isActive).toBe(false)
  })

  it("cancelPull patches an existing pulling entry to cancelled while keeping percentage", async () => {
    const { result } = renderHook(() => useOllama({ baseUrl: "http://127.0.0.1:11434" }))
    await act(async () => {
      await result.current.pullModel("llama3")
    })
    await act(async () => {
      await result.current.cancelPull("llama3")
    })
    expect(result.current.pullStates.get("llama3")?.status).toBe("cancelled")
    expect(result.current.pullStates.get("llama3")?.isActive).toBe(false)
  })

  it("deleteModel + stopModel surface the deferred-binding error message", async () => {
    const { result } = renderHook(() => useOllama({ baseUrl: "http://127.0.0.1:11434" }))
    // Let the initial useEffect-driven refresh finish so its
    // `setError(null)` happy-path doesn't race the assertions below.
    await waitFor(() => expect(result.current.status?.state).toBe("connected"))
    await act(async () => {
      await result.current.deleteModel("llama3")
    })
    expect(result.current.error).toMatch(/deleteModel/)
    await act(async () => {
      await result.current.stopModel("qwen2.5")
    })
    expect(result.current.error).toMatch(/stopModel/)
  })
})
