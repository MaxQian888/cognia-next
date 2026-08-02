/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react"

const liveQueryResults: unknown[] = []
let liveQueryCall = 0

jest.mock("dexie-react-hooks", () => ({
  // Each `useLiveQuery` call in the hook, in order, gets the next queued value;
  // an unqueued call falls back to its own `initial` so the shape stays valid.
  useLiveQuery: (_query: unknown, _deps: unknown, initial: unknown) => {
    const queued = liveQueryResults[liveQueryCall++]
    return queued === undefined ? initial : queued
  },
}))

jest.mock("@/lib/db/schema", () => ({ getDb: () => ({}) }))

const isTauri = jest.fn(() => true)
jest.mock("@/lib/tauri", () => ({ isTauri: () => isTauri() }))

const loadCompanionConfig = jest.fn<unknown, []>(() => null)
jest.mock("@/lib/tauri/transport-companion", () => ({
  loadCompanionConfig: () => loadCompanionConfig(),
}))

jest.mock("@/lib/provider-diagnostics/balance", () => ({
  projectLegacyProviderBalanceRows: () => ({ sources: [], snapshots: [] }),
}))

const fetchStatus = jest.fn()
const fetchHistory = jest.fn()
jest.mock("@/lib/provider-diagnostics/remote-client", () => ({
  fetchRemoteProviderDiagnosticsStatus: (...args: unknown[]) => fetchStatus(...args),
  fetchRemoteProviderDiagnosticsHistory: (...args: unknown[]) => fetchHistory(...args),
  getCachedRemoteProviderDiagnosticsStatus: () => null,
  getCachedRemoteProviderDiagnosticsHistory: () => null,
}))

jest.mock("@/lib/provider-diagnostics/store", () => ({
  queryProviderDiagnosticHistory: jest.fn(),
}))

import { useProviderDiagnosticsData } from "./use-provider-diagnostics-data"

const NOW = 1_700_000_000_000

function sample(overrides: Record<string, unknown> = {}) {
  return {
    id: "s1",
    providerId: "openai",
    targetId: "t1",
    startedAt: NOW,
    status: "completed",
    sampleRole: "measured",
    ...overrides,
  }
}

function queueLiveQueries(values: unknown[]) {
  liveQueryResults.length = 0
  liveQueryResults.push(...values)
}

describe("useProviderDiagnosticsData", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers().setSystemTime(NOW)
    liveQueryCall = 0
    liveQueryResults.length = 0
    isTauri.mockReturnValue(true)
    loadCompanionConfig.mockReturnValue(null)
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  // Order matters: samples, jobs, balances, legacy projection, endpoint changes.
  const render = () => {
    liveQueryCall = 0
    return renderHook(() => useProviderDiagnosticsData("openai"))
  }

  it("reads Dexie on the desktop and reports itself as not paired", () => {
    queueLiveQueries([[sample()], [{ id: "j1" }], [], undefined, []])
    const { result } = render()
    expect(result.current.pairedClient).toBe(false)
    expect(result.current.samples).toHaveLength(1)
    expect(result.current.jobs).toEqual([{ id: "j1" }])
    expect(fetchStatus).not.toHaveBeenCalled()
  })

  it("narrows measured samples and exposes the newest one", () => {
    queueLiveQueries([
      [sample({ id: "measured" }), sample({ id: "warmup", sampleRole: "warmup" })],
      [],
      [],
      undefined,
      [],
    ])
    const { result } = render()
    expect(result.current.measuredSamples.map((s) => s.id)).toEqual(["measured"])
    expect(result.current.latestSample?.id).toBe("measured")
  })

  it("is not stale with no samples at all", () => {
    queueLiveQueries([[], [], [], undefined, []])
    expect(render().result.current.stale).toBe(false)
  })

  it("marks a sample older than fifteen minutes as stale", () => {
    queueLiveQueries([[sample({ startedAt: NOW - 16 * 60_000 })], [], [], undefined, []])
    expect(render().result.current.stale).toBe(true)
  })

  it("keeps a recent sample fresh", () => {
    queueLiveQueries([[sample({ startedAt: NOW - 60_000 })], [], [], undefined, []])
    expect(render().result.current.stale).toBe(false)
  })

  describe("paired client", () => {
    beforeEach(() => {
      isTauri.mockReturnValue(false)
      loadCompanionConfig.mockReturnValue({ host: "desktop" })
      fetchStatus.mockResolvedValue({ jobs: [{ id: "remote-job" }], stale: true })
      fetchHistory.mockResolvedValue({ samples: [sample({ id: "remote-sample" })], stale: true })
    })

    it("reads the desktop projection instead of Dexie", async () => {
      queueLiveQueries([[sample({ id: "local" })], [{ id: "local-job" }], [], undefined, []])
      const { result } = render()
      expect(result.current.pairedClient).toBe(true)

      await waitFor(() => expect(result.current.samples).toHaveLength(1))
      expect(result.current.samples[0].id).toBe("remote-sample")
      expect(result.current.jobs).toEqual([{ id: "remote-job" }])
    })

    it("trusts the desktop's staleness verdict over its own clock", async () => {
      queueLiveQueries([[], [], [], undefined, []])
      const { result } = render()
      await waitFor(() => expect(result.current.stale).toBe(true))
    })

    it("re-reads on an interval", async () => {
      queueLiveQueries([[], [], [], undefined, []])
      render()
      await waitFor(() => expect(fetchStatus).toHaveBeenCalledTimes(1))
      await act(async () => {
        jest.advanceTimersByTime(10_000)
      })
      await waitFor(() => expect(fetchStatus).toHaveBeenCalledTimes(2))
    })

    it("re-reads when the tab becomes visible again", async () => {
      queueLiveQueries([[], [], [], undefined, []])
      render()
      await waitFor(() => expect(fetchStatus).toHaveBeenCalledTimes(1))
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"))
      })
      await waitFor(() => expect(fetchStatus).toHaveBeenCalledTimes(2))
    })

    it("refreshes on demand after a job is started or cancelled", async () => {
      queueLiveQueries([[], [], [], undefined, []])
      const { result } = render()
      await waitFor(() => expect(fetchStatus).toHaveBeenCalledTimes(1))
      await act(async () => {
        await result.current.refreshRemoteStatus()
      })
      expect(fetchStatus).toHaveBeenCalledTimes(2)
    })

    it("stops polling once unmounted", async () => {
      queueLiveQueries([[], [], [], undefined, []])
      const { unmount } = render()
      await waitFor(() => expect(fetchStatus).toHaveBeenCalledTimes(1))
      unmount()
      await act(async () => {
        jest.advanceTimersByTime(30_000)
      })
      expect(fetchStatus).toHaveBeenCalledTimes(1)
    })
  })

  it("does not attempt a remote refresh on the desktop", async () => {
    queueLiveQueries([[], [], [], undefined, []])
    const { result } = render()
    await act(async () => {
      await result.current.refreshRemoteStatus()
    })
    expect(fetchStatus).not.toHaveBeenCalled()
  })
})
