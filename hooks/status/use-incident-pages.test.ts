jest.mock("@/lib/network/platform-fetch", () => ({ createPlatformFetch: jest.fn() }))

import { act, renderHook } from "@testing-library/react"

import { createPlatformFetch } from "@/lib/network/platform-fetch"
import { FIXTURE_ACTIVE_INCIDENT, FIXTURE_PAST_INCIDENT } from "@/lib/status/fixtures"
import type { IncidentSummary, StatusRuntime } from "@/lib/status/public-status"

import { INCIDENT_PAGE_SIZE, mergeIncidentLists, useIncidentPages } from "./use-incident-pages"

const runtime: StatusRuntime = {
  mode: "primary",
  apiBase: "/api/status/v1",
  primaryPageUrl: "https://status.cognia.cn/status/",
  allowsConsentWrites: true,
}

const fetchMock = jest.fn()

function respond(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) }
}

function incident(id: string, startedAt: string, revision = 1): IncidentSummary {
  return { ...FIXTURE_PAST_INCIDENT, id, startedAt, revision }
}

async function flush() {
  await act(async () => {
    for (let index = 0; index < 10; index += 1) await Promise.resolve()
  })
}

beforeEach(() => {
  fetchMock.mockReset()
  ;(createPlatformFetch as jest.Mock).mockReturnValue(fetchMock)
})

describe("mergeIncidentLists", () => {
  it("de-duplicates by ID keeping the newest revision, drops active ones and sorts newest first", () => {
    const old = incident("inc_a", "2026-09-01T00:00:00.000Z", 1)
    const revised = { ...old, revision: 2, state: "resolved" as const }
    const newer = incident("inc_b", "2026-09-20T00:00:00.000Z")
    const active = incident("inc_active", "2026-10-01T00:00:00.000Z")
    const merged = mergeIncidentLists(
      [
        [old, active],
        [revised, newer],
      ],
      new Set(["inc_active"])
    )
    expect(merged.map((item) => item.id)).toEqual(["inc_b", "inc_a"])
    expect(merged[1]!.revision).toBe(2)
  })
})

describe("useIncidentPages", () => {
  const base = { past: [FIXTURE_PAST_INCIDENT], active: [FIXTURE_ACTIVE_INCIDENT] }

  it("starts from the snapshot's past incidents", () => {
    const { result } = renderHook(() => useIncidentPages(runtime, base))
    expect(result.current.incidents.map((item) => item.id)).toEqual([FIXTURE_PAST_INCIDENT.id])
    expect(result.current.hasMore).toBe(true)
  })

  it("walks the cursor until the API reports no older page", async () => {
    const page1 = [FIXTURE_PAST_INCIDENT, incident("inc_older", "2026-08-01T00:00:00.000Z")]
    const page2 = [incident("inc_oldest", "2026-07-01T00:00:00.000Z")]
    fetchMock.mockResolvedValueOnce(
      respond(200, { schemaVersion: 1, incidents: page1, nextCursor: "c2" })
    )
    fetchMock.mockResolvedValueOnce(
      respond(200, { schemaVersion: 1, incidents: page2, nextCursor: null })
    )
    const { result } = renderHook(() => useIncidentPages(runtime, base))

    act(() => result.current.loadMore())
    expect(result.current.loading).toBe(true)
    await flush()
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/status/v1/incidents?limit=${INCIDENT_PAGE_SIZE}`)
    expect(result.current.incidents.map((item) => item.id)).toEqual([
      FIXTURE_PAST_INCIDENT.id,
      "inc_older",
    ])
    expect(result.current.hasMore).toBe(true)

    act(() => result.current.loadMore())
    await flush()
    expect(fetchMock.mock.calls[1][0]).toBe(
      `/api/status/v1/incidents?limit=${INCIDENT_PAGE_SIZE}&cursor=c2`
    )
    expect(result.current.incidents.map((item) => item.id)).toEqual([
      FIXTURE_PAST_INCIDENT.id,
      "inc_older",
      "inc_oldest",
    ])
    expect(result.current.hasMore).toBe(false)
    expect(result.current.loading).toBe(false)
  })

  it("reports a failed page and allows another attempt", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("offline"))
    fetchMock.mockResolvedValueOnce(
      respond(200, { schemaVersion: 1, incidents: [], nextCursor: null })
    )
    const { result } = renderHook(() => useIncidentPages(runtime, base))
    act(() => result.current.loadMore())
    await flush()
    expect(result.current.error).toBe("network")
    act(() => result.current.loadMore())
    await flush()
    expect(result.current.error).toBeNull()
    expect(result.current.hasMore).toBe(false)
  })

  it("aborts a pending page on unmount", async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}))
    const { result, unmount } = renderHook(() => useIncidentPages(runtime, base))
    act(() => result.current.loadMore())
    await flush()
    const signal: AbortSignal = fetchMock.mock.calls[0][1].signal
    unmount()
    expect(signal.aborted).toBe(true)
  })
})
