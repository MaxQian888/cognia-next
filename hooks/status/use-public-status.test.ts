jest.mock("@/lib/network/platform-fetch", () => ({ createPlatformFetch: jest.fn() }))

import { act, renderHook } from "@testing-library/react"

import { createPlatformFetch } from "@/lib/network/platform-fetch"
import { createStatusFixture, FIXTURE_NOW_MS } from "@/lib/status/fixtures"
import type { HistoryRange, StatusRuntime } from "@/lib/status/public-status"

import {
  STATUS_MAX_BACKOFF_MS,
  STATUS_POLL_INTERVAL_MS,
  statusBackoffDelayMs,
  usePublicStatus,
} from "./use-public-status"

const runtime: StatusRuntime = {
  mode: "primary",
  apiBase: "/api/status/v1",
  primaryPageUrl: "https://status.cognia.cn/status/",
  allowsConsentWrites: true,
}

const fetchMock = jest.fn()
let visibility: DocumentVisibilityState = "visible"

function respond(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  }
}

function deferred() {
  let resolve!: (value: unknown) => void
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function flush() {
  await act(async () => {
    for (let index = 0; index < 10; index += 1) await Promise.resolve()
  })
}

function setVisibility(next: DocumentVisibilityState) {
  visibility = next
  document.dispatchEvent(new Event("visibilitychange"))
}

beforeAll(() => {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  })
})

beforeEach(() => {
  jest.useFakeTimers({ now: FIXTURE_NOW_MS })
  visibility = "visible"
  fetchMock.mockReset()
  ;(createPlatformFetch as jest.Mock).mockReturnValue(fetchMock)
})

afterEach(() => {
  jest.useRealTimers()
})

const noJitter = () => 0

describe("statusBackoffDelayMs", () => {
  it("grows exponentially with jitter and never exceeds five minutes", () => {
    expect(statusBackoffDelayMs(1, () => 0)).toBe(7_500)
    expect(statusBackoffDelayMs(1, () => 1)).toBe(15_000)
    expect(statusBackoffDelayMs(2, () => 1)).toBe(30_000)
    expect(statusBackoffDelayMs(20, () => 1)).toBe(STATUS_MAX_BACKOFF_MS)
    expect(statusBackoffDelayMs(20, () => 0)).toBe(STATUS_MAX_BACKOFF_MS / 2)
  })
})

describe("usePublicStatus", () => {
  it("loads a validated snapshot for the selected range and reports it fresh", async () => {
    fetchMock.mockResolvedValue(respond(200, createStatusFixture("operational", "90d")))
    const { result } = renderHook(() => usePublicStatus(runtime))
    expect(result.current.loaded).toBeNull()
    expect(result.current.pendingRange).toBe(true)
    await flush()
    expect(fetchMock.mock.calls[0][0]).toBe("/api/status/v1/snapshot?range=90d")
    expect(result.current.loaded?.snapshot.range).toBe("90d")
    expect(result.current.pendingRange).toBe(false)
    expect(result.current.error).toBeNull()
    expect(result.current.freshness).toMatchObject({ stale: false, clockUncertain: false })
  })

  it("polls every 60 s while visible", async () => {
    fetchMock.mockResolvedValue(respond(200, createStatusFixture("operational", "90d")))
    renderHook(() => usePublicStatus(runtime))
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await act(async () => {
      jest.advanceTimersByTime(STATUS_POLL_INTERVAL_MS)
    })
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("pauses while hidden and refreshes at once when the tab is visible again", async () => {
    fetchMock.mockResolvedValue(respond(200, createStatusFixture("operational", "90d")))
    renderHook(() => usePublicStatus(runtime))
    await flush()
    act(() => setVisibility("hidden"))
    await act(async () => {
      jest.advanceTimersByTime(5 * STATUS_POLL_INTERVAL_MS)
    })
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    act(() => setVisibility("visible"))
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("shows unknown (no snapshot) with the failure when the first request fails, then backs off", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"))
    const { result } = renderHook(() => usePublicStatus(runtime, { random: noJitter }))
    await flush()
    expect(result.current.loaded).toBeNull()
    expect(result.current.error).toMatchObject({ kind: "network", failures: 1 })
    await act(async () => {
      jest.advanceTimersByTime(statusBackoffDelayMs(1, noJitter) - 1)
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await act(async () => {
      jest.advanceTimersByTime(1)
    })
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.current.error).toMatchObject({ failures: 2 })
  })

  it("keeps the last validated snapshot with its original timestamps when a refresh fails", async () => {
    const snapshot = createStatusFixture("operational", "90d")
    fetchMock.mockResolvedValueOnce(respond(200, snapshot))
    fetchMock.mockResolvedValueOnce(respond(503, { code: "unavailable", requestId: "r" }))
    const { result } = renderHook(() => usePublicStatus(runtime))
    await flush()
    const fetchedAt = result.current.loaded?.fetchedAtClientMs
    await act(async () => {
      jest.advanceTimersByTime(STATUS_POLL_INTERVAL_MS)
    })
    await flush()
    expect(result.current.error).toMatchObject({ kind: "http" })
    expect(result.current.loaded?.snapshot.generatedAt).toBe(snapshot.generatedAt)
    expect(result.current.loaded?.fetchedAtClientMs).toBe(fetchedAt)
  })

  it("never falls back to anything on an unsupported schema", async () => {
    fetchMock.mockResolvedValue(
      respond(200, { ...createStatusFixture("operational", "90d"), schemaVersion: 2 })
    )
    const { result } = renderHook(() => usePublicStatus(runtime))
    await flush()
    expect(result.current.loaded).toBeNull()
    expect(result.current.error?.kind).toBe("unsupported")
  })

  it("marks the snapshot stale as time passes without a new one", async () => {
    fetchMock.mockResolvedValueOnce(respond(200, createStatusFixture("operational", "90d")))
    fetchMock.mockImplementation(() => new Promise(() => {}))
    const { result } = renderHook(() => usePublicStatus(runtime))
    await flush()
    expect(result.current.freshness?.stale).toBe(false)
    await act(async () => {
      jest.advanceTimersByTime(4 * 60_000)
    })
    expect(result.current.freshness?.stale).toBe(true)
  })

  it("does not let a superseded range response overwrite the newer range", async () => {
    const slow = deferred()
    const fast = deferred()
    fetchMock.mockImplementation((url: string) =>
      url.endsWith("range=90d") ? slow.promise : fast.promise
    )
    const { result } = renderHook(() => usePublicStatus(runtime))
    await flush()
    const firstSignal: AbortSignal = fetchMock.mock.calls[0][1].signal
    act(() => result.current.setRange("24h" as HistoryRange))
    await flush()
    expect(firstSignal.aborted).toBe(true)
    fast.resolve(respond(200, createStatusFixture("degraded", "24h")))
    await flush()
    slow.resolve(respond(200, createStatusFixture("operational", "90d")))
    await flush()
    expect(result.current.range).toBe("24h")
    expect(result.current.loaded?.snapshot.range).toBe("24h")
    expect(result.current.loaded?.snapshot.overallStatus).toBe("degraded")
  })

  it("keeps a newer revision when a poll returns an older aggregate", async () => {
    const newer = { ...createStatusFixture("major_outage", "90d"), revision: 20 }
    const older = { ...createStatusFixture("operational", "90d"), revision: 19 }
    fetchMock.mockResolvedValueOnce(respond(200, newer))
    fetchMock.mockResolvedValueOnce(respond(200, older))
    const { result } = renderHook(() => usePublicStatus(runtime))
    await flush()
    await act(async () => {
      jest.advanceTimersByTime(STATUS_POLL_INTERVAL_MS)
    })
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.current.loaded?.snapshot.revision).toBe(20)
    expect(result.current.loaded?.snapshot.overallStatus).toBe("major_outage")
  })

  it("rejects a snapshot for a range it did not ask for", async () => {
    fetchMock.mockResolvedValue(respond(200, createStatusFixture("operational", "7d")))
    const { result } = renderHook(() => usePublicStatus(runtime))
    await flush()
    expect(result.current.loaded).toBeNull()
    expect(result.current.error?.kind).toBe("invalid")
  })

  it("aborts the in-flight request and stops polling on unmount", async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}))
    const { unmount } = renderHook(() => usePublicStatus(runtime))
    await flush()
    const signal: AbortSignal = fetchMock.mock.calls[0][1].signal
    unmount()
    expect(signal.aborted).toBe(true)
    await act(async () => {
      jest.advanceTimersByTime(10 * STATUS_POLL_INTERVAL_MS)
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("retries on demand", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("offline"))
    fetchMock.mockResolvedValueOnce(respond(200, createStatusFixture("operational", "90d")))
    const { result } = renderHook(() => usePublicStatus(runtime, { random: () => 1 }))
    await flush()
    expect(result.current.error).not.toBeNull()
    act(() => result.current.refresh())
    expect(result.current.refreshing).toBe(true)
    await flush()
    expect(result.current.loaded).not.toBeNull()
    expect(result.current.error).toBeNull()
    expect(result.current.refreshing).toBe(false)
  })

  it("does nothing until the runtime is known", async () => {
    renderHook(() => usePublicStatus(null))
    await flush()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
