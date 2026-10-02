jest.mock("@/lib/network/platform-fetch", () => ({ createPlatformFetch: jest.fn() }))

import { act, renderHook } from "@testing-library/react"

import { createPlatformFetch } from "@/lib/network/platform-fetch"
import { FIXTURE_ACTIVE_INCIDENT } from "@/lib/status/fixtures"
import type { IncidentDetail, StatusRuntime } from "@/lib/status/public-status"

import { readIncidentQuery, useIncidentDetail } from "./use-incident-detail"

const runtime: StatusRuntime = {
  mode: "primary",
  apiBase: "/api/status/v1",
  primaryPageUrl: "https://status.cognia.cn/status/",
  allowsConsentWrites: true,
}

const fetchMock = jest.fn()

const detail: IncidentDetail = {
  ...FIXTURE_ACTIVE_INCIDENT,
  updates: [FIXTURE_ACTIVE_INCIDENT.latestUpdate!],
}

function respond(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) }
}

async function flush() {
  await act(async () => {
    for (let index = 0; index < 10; index += 1) await Promise.resolve()
  })
}

beforeEach(() => {
  fetchMock.mockReset()
  ;(createPlatformFetch as jest.Mock).mockReturnValue(fetchMock)
  window.history.replaceState(null, "", "/status/")
})

describe("readIncidentQuery", () => {
  it("accepts a contract-shaped ID and flags anything else", () => {
    expect(readIncidentQuery("?incident=inc_1")).toEqual({ id: "inc_1", invalid: false })
    expect(readIncidentQuery("")).toEqual({ id: null, invalid: false })
    expect(readIncidentQuery("?incident=../admin")).toEqual({ id: null, invalid: true })
    expect(readIncidentQuery("?incident=")).toEqual({ id: null, invalid: true })
  })
})

describe("useIncidentDetail", () => {
  it("opens the incident named in the URL on load (deep link)", async () => {
    window.history.replaceState(null, "", `/status/?incident=${detail.id}`)
    fetchMock.mockResolvedValue(respond(200, { schemaVersion: 1, incident: detail }))
    const { result } = renderHook(() => useIncidentDetail(runtime))
    expect(result.current.selectedId).toBe(detail.id)
    expect(result.current.status).toBe("loading")
    await flush()
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/status/v1/incidents/${detail.id}`)
    expect(result.current.status).toBe("ready")
    expect(result.current.detail?.id).toBe(detail.id)
  })

  it("keeps the query in sync when opening and closing", async () => {
    fetchMock.mockResolvedValue(respond(200, { schemaVersion: 1, incident: detail }))
    window.history.replaceState(null, "", "/status/?lang=en#top")
    const { result } = renderHook(() => useIncidentDetail(runtime))
    expect(result.current.status).toBe("idle")
    act(() => result.current.open(detail.id))
    expect(window.location.search).toBe(`?lang=en&incident=${detail.id}`)
    expect(window.location.hash).toBe("#top")
    await flush()
    expect(result.current.status).toBe("ready")
    act(() => result.current.close())
    expect(window.location.search).toBe("?lang=en")
    expect(result.current.status).toBe("idle")
  })

  it("shows not found for a 404", async () => {
    window.history.replaceState(null, "", "/status/?incident=inc_missing")
    fetchMock.mockResolvedValue(respond(404, { code: "not_found", requestId: "r" }))
    const { result } = renderHook(() => useIncidentDetail(runtime))
    await flush()
    expect(result.current.status).toBe("not_found")
  })

  it("reports an invalid ID without requesting it and clears it from the URL", async () => {
    window.history.replaceState(null, "", "/status/?incident=%2F..%2Fsecret")
    const { result } = renderHook(() => useIncidentDetail(runtime))
    await flush()
    expect(result.current.status).toBe("invalid")
    expect(fetchMock).not.toHaveBeenCalled()
    expect(window.location.search).toBe("")
  })

  it("retries after an error", async () => {
    window.history.replaceState(null, "", `/status/?incident=${detail.id}`)
    fetchMock.mockRejectedValueOnce(new TypeError("offline"))
    fetchMock.mockResolvedValueOnce(respond(200, { schemaVersion: 1, incident: detail }))
    const { result } = renderHook(() => useIncidentDetail(runtime))
    await flush()
    expect(result.current.status).toBe("error")
    expect(result.current.errorKind).toBe("network")
    act(() => result.current.retry())
    expect(result.current.status).toBe("loading")
    await flush()
    expect(result.current.status).toBe("ready")
  })

  it("rejects a detail whose ID does not match the request", async () => {
    window.history.replaceState(null, "", "/status/?incident=inc_other")
    fetchMock.mockResolvedValue(respond(200, { schemaVersion: 1, incident: detail }))
    const { result } = renderHook(() => useIncidentDetail(runtime))
    await flush()
    expect(result.current.status).toBe("error")
  })

  it("aborts the detail request on unmount", async () => {
    window.history.replaceState(null, "", `/status/?incident=${detail.id}`)
    fetchMock.mockImplementation(() => new Promise(() => {}))
    const { unmount } = renderHook(() => useIncidentDetail(runtime))
    await flush()
    const signal: AbortSignal = fetchMock.mock.calls[0][1].signal
    unmount()
    expect(signal.aborted).toBe(true)
  })
})
