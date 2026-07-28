/**
 * @jest-environment jsdom
 */
import { renderHook, waitFor, act } from "@testing-library/react"
import { DEFAULT_MEMORY_CONFIG, type MemoryConfig } from "@/types/memory/memory"
import type { Memory } from "@/types/memory/memory"

const mockListMemories = jest.fn()
const mockListJobs = jest.fn()
const mockListAuditSince = jest.fn()
const mockEarliest = jest.fn()
const mockDescribeMode = jest.fn()

jest.mock("@/lib/db/memories", () => ({
  listMemories: (...a: unknown[]) => mockListMemories(...a),
}))
jest.mock("@/lib/db/memory-governance", () => ({
  listMemoryJobs: (...a: unknown[]) => mockListJobs(...a),
  listMemoryAuditEventsSince: (...a: unknown[]) => mockListAuditSince(...a),
  findEarliestInstrumentedAuditAt: (...a: unknown[]) => mockEarliest(...a),
}))
jest.mock("@/lib/memory/runtime/build-deps", () => ({
  describeMemoryRetrievalMode: (...a: unknown[]) => mockDescribeMode(...a),
}))

// A minimal useLiveQuery: run the querier once per dependency change and expose
// its resolution. Enough to exercise the loading/loaded transitions this hook
// depends on without standing up fake-indexeddb.
jest.mock("dexie-react-hooks", () => {
  const react = jest.requireActual<typeof import("react")>("react")
  const { act } =
    jest.requireActual<typeof import("@testing-library/react")>("@testing-library/react")
  return {
    useLiveQuery: <T>(querier: () => Promise<T>, deps: unknown[] = []) => {
      const [value, setValue] = react.useState<T | undefined>(undefined)
      react.useEffect(() => {
        let cancelled = false
        void Promise.resolve(querier()).then((v) => {
          // The real hook resolves outside React's knowledge too; wrapping keeps
          // the async landing from drowning the run in act() warnings.
          if (!cancelled) act(() => setValue(v))
        })
        return () => {
          cancelled = true
        }
      }, deps)
      return value
    },
  }
})

import { useMemoryInsights, MAINTENANCE_WINDOW_DAYS } from "./use-memory-insights"

const DAY = 24 * 60 * 60 * 1000

function memory(over: Partial<Memory> = {}): Memory {
  const now = Date.now()
  return {
    id: `mem_${Math.random().toString(36).slice(2)}`,
    scope: "global",
    type: "semantic",
    text: "the user prefers pnpm",
    tags: [],
    importance: 7,
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: now,
    accessCount: 0,
    version: 1,
    status: "active",
    pinned: false,
    provenance: "user",
    ...over,
  }
}

function cfg(over: Partial<MemoryConfig> = {}): MemoryConfig {
  return { ...DEFAULT_MEMORY_CONFIG, ...over }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockListMemories.mockResolvedValue([])
  mockListJobs.mockResolvedValue([])
  mockListAuditSince.mockResolvedValue([])
  mockEarliest.mockResolvedValue(undefined)
  mockDescribeMode.mockResolvedValue({ kind: "hybrid", provider: "transformersjs" })
})

describe("useMemoryInsights", () => {
  it("reports loading until the corpus query resolves, then derives counts", async () => {
    mockListMemories.mockResolvedValue([
      memory({ scope: "global", vectorDocId: "v1" }),
      memory({ scope: "workspace" }),
    ])

    const { result } = renderHook(() => useMemoryInsights(cfg()))
    expect(result.current.loading).toBe(true)

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.corpus.stats.active).toBe(2)
    expect(result.current.corpus.byScope).toMatchObject({ global: 1, workspace: 1 })
    expect(result.current.corpus.vector.coverage).toBe(0.5)
  })

  it("withholds the maintenance summary until every input has landed", async () => {
    // Guards the flash this hook was written to avoid: a user with exact data
    // must never briefly see the "estimated" accounting.
    let resolveEarliest: (v: number | undefined) => void = () => {}
    mockEarliest.mockReturnValue(
      new Promise<number | undefined>((resolve) => {
        resolveEarliest = resolve
      })
    )

    const { result } = renderHook(() => useMemoryInsights(cfg()))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.maintenance).toBeUndefined()

    await act(async () => {
      resolveEarliest(Date.now() - 90 * DAY)
    })
    await waitFor(() => expect(result.current.maintenance).toBeDefined())
    expect(result.current.maintenance?.accounting).toEqual({ kind: "exact" })
  })

  it("queries audit events over a window that does not move between renders", async () => {
    const { result, rerender } = renderHook(() => useMemoryInsights(cfg()))
    await waitFor(() => expect(result.current.loading).toBe(false))
    const firstWindow = result.current.maintenanceWindowStart

    rerender()
    rerender()

    expect(result.current.maintenanceWindowStart).toBe(firstWindow)
    expect(mockListAuditSince).toHaveBeenCalledTimes(1)
    expect(mockListAuditSince).toHaveBeenCalledWith(firstWindow)
    expect(Date.now() - firstWindow).toBeGreaterThanOrEqual(MAINTENANCE_WINDOW_DAYS * DAY - 1000)
  })

  it("probes the retrieval mode once and exposes the verdict", async () => {
    mockDescribeMode.mockResolvedValue({
      kind: "bm25",
      reason: "cloud_blocked",
      provider: "openai",
    })
    const { result } = renderHook(() => useMemoryInsights(cfg()))

    await waitFor(() =>
      expect(result.current.retrievalMode).toEqual({
        kind: "bm25",
        reason: "cloud_blocked",
        provider: "openai",
      })
    )
    expect(mockDescribeMode).toHaveBeenCalledTimes(1)
  })

  it("re-probes when a config field the probe reads changes, and not otherwise", async () => {
    const { result, rerender } = renderHook(
      ({ config }: { config: MemoryConfig }) => useMemoryInsights(config),
      { initialProps: { config: cfg() } }
    )
    await waitFor(() => expect(result.current.retrievalMode).toBeDefined())
    expect(mockDescribeMode).toHaveBeenCalledTimes(1)

    // Irrelevant to the backend decision — must not re-probe.
    rerender({ config: cfg({ retrievalTopK: 12 }) })
    expect(mockDescribeMode).toHaveBeenCalledTimes(1)

    // Directly flips the privacy gate — must re-probe.
    rerender({ config: cfg({ allowCloudEmbedding: true }) })
    await waitFor(() => expect(mockDescribeMode).toHaveBeenCalledTimes(2))
  })

  it("re-probes on demand via refreshRetrievalMode", async () => {
    const { result } = renderHook(() => useMemoryInsights(cfg()))
    await waitFor(() => expect(result.current.retrievalMode).toBeDefined())

    await act(async () => {
      result.current.refreshRetrievalMode()
    })
    await waitFor(() => expect(mockDescribeMode).toHaveBeenCalledTimes(2))
  })

  it("keeps the pane usable when the probe rejects outright", async () => {
    mockDescribeMode.mockRejectedValue(new Error("boom"))
    const { result } = renderHook(() => useMemoryInsights(cfg()))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.retrievalMode).toBeUndefined()
    expect(result.current.corpus.stats.active).toBe(0)
  })

  it("always reports all three job kinds, even before rows load", async () => {
    const { result } = renderHook(() => useMemoryInsights(cfg()))
    expect(result.current.jobs.map((j) => j.kind)).toEqual([
      "turn-extraction",
      "session-distill",
      "vector-reconcile",
    ])
    // Let the in-flight probe land before unmount, or its setState lands on a
    // torn-down tree and React warns.
    await waitFor(() => expect(result.current.retrievalMode).toBeDefined())
  })
})
