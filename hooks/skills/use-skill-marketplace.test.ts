/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react"

const fetchRegistryMock = jest.fn()
const fetchSkillsShMock = jest.fn()
const fetchLeaderboardMock = jest.fn()
const fetchCuratedMock = jest.fn()
const fetchAuditMock = jest.fn()
const fetchDetailMock = jest.fn()
const webBlockedMock = jest.fn().mockReturnValue(false)
const installMock = jest.fn()
const uninstallMock = jest.fn()
const listInstalledMock = jest.fn().mockResolvedValue([])
const liveQueryMock = jest.fn()
let mockSettings: Record<string, unknown> = {}

jest.mock("@/lib/skills/marketplace-registry", () => ({
  fetchRegistryItems: () => fetchRegistryMock(),
}))

jest.mock("@/lib/skills/marketplace-skillssh", () => {
  class SkillsShTokenError extends Error {
    constructor(message: string) {
      super(message)
      this.name = "SkillsShTokenError"
    }
  }
  return {
    SkillsShTokenError,
    fetchSkillsShItems: (q: unknown) => fetchSkillsShMock(q),
    fetchSkillsShLeaderboard: (view: unknown, page: unknown, perPage: unknown) =>
      fetchLeaderboardMock(view, page, perPage),
    fetchSkillsShCurated: () => fetchCuratedMock(),
    fetchSkillsShAudit: (item: unknown) => fetchAuditMock(item),
    fetchSkillsShDetail: (item: unknown) => fetchDetailMock(item),
  }
})

jest.mock("@/lib/skills/skillssh-http", () => ({
  isSkillsShWebBlocked: () => webBlockedMock(),
}))

jest.mock("@/lib/skills/marketplace-install", () => ({
  installMarketplaceItem: (item: unknown) => installMock(item),
  uninstallMarketplaceItem: (item: unknown) => uninstallMock(item),
  listInstalledCanonicalIds: () => listInstalledMock(),
}))

jest.mock("@/lib/db/skills", () => ({
  listSkills: jest.fn(async () => []),
}))

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: <T>(fn: () => Promise<T> | T): T | undefined => liveQueryMock(fn) as T | undefined,
}))

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: { settings: Record<string, unknown> }) => unknown) =>
    selector({ settings: mockSettings }),
}))

import { SkillsShTokenError } from "@/lib/skills/marketplace-skillssh"
import { useSkillMarketplace } from "./use-skill-marketplace"

beforeEach(() => {
  fetchRegistryMock.mockReset().mockResolvedValue([])
  fetchSkillsShMock.mockReset().mockResolvedValue([])
  fetchLeaderboardMock.mockReset().mockResolvedValue({ items: [], hasMore: false })
  fetchCuratedMock.mockReset().mockResolvedValue([])
  fetchAuditMock.mockReset().mockResolvedValue(null)
  fetchDetailMock.mockReset().mockResolvedValue({ files: [] })
  webBlockedMock.mockReset().mockReturnValue(false)
  installMock.mockReset().mockResolvedValue(undefined)
  uninstallMock.mockReset().mockResolvedValue(undefined)
  listInstalledMock.mockReset().mockResolvedValue([])
  liveQueryMock.mockReset().mockReturnValue([])
  mockSettings = {}
})

const sampleItem = (overrides: Record<string, unknown> = {}): never =>
  ({
    id: "i-1",
    source: "skillssh",
    sourceId: "o/r/s",
    name: "Item",
    description: "desc",
    tags: ["a"],
    ...overrides,
  }) as never

describe("useSkillMarketplace — search view", () => {
  it("loads registry + skills.sh search on mount and merges them", async () => {
    fetchRegistryMock.mockResolvedValueOnce([sampleItem({ id: "r-1", name: "R1" })])
    fetchSkillsShMock.mockResolvedValueOnce([sampleItem({ id: "s-1", name: "S1" })])
    const { result } = renderHook(() => useSkillMarketplace())
    await waitFor(() => expect(result.current.state.loading).toBe(false))
    expect(result.current.state.items.map((i) => i.id)).toEqual(["r-1", "s-1"])
  })

  it("filters by query (name / description / tags / repository)", async () => {
    const items = [
      sampleItem({ id: "x", name: "Foo", description: "" }),
      sampleItem({ id: "y", name: "Bar", description: "world" }),
    ]
    fetchRegistryMock.mockResolvedValue(items)
    fetchSkillsShMock.mockResolvedValue([])
    const { result } = renderHook(() => useSkillMarketplace())
    await waitFor(() => expect(result.current.state.loading).toBe(false))
    await act(async () => {
      result.current.setQuery("world")
    })
    await waitFor(() => expect(result.current.state.items.map((i) => i.id)).toEqual(["y"]))
  })

  it("source filter: registry only skips the skills.sh search", async () => {
    const { result } = renderHook(() => useSkillMarketplace())
    await waitFor(() => expect(result.current.state.loading).toBe(false))
    const callsAfterMount = fetchSkillsShMock.mock.calls.length
    fetchRegistryMock.mockResolvedValueOnce([sampleItem({ id: "r2" })])
    await act(async () => {
      result.current.setSource("registry")
    })
    await waitFor(() => expect(result.current.state.items.map((i) => i.id)).toEqual(["r2"]))
    expect(fetchSkillsShMock).toHaveBeenCalledTimes(callsAfterMount)
  })

  it("webBlocked skips skills.sh entirely and is exposed", async () => {
    webBlockedMock.mockReturnValue(true)
    const { result } = renderHook(() => useSkillMarketplace())
    await waitFor(() => expect(result.current.state.loading).toBe(false))
    expect(result.current.webBlocked).toBe(true)
    expect(fetchSkillsShMock).not.toHaveBeenCalled()
  })

  it("fetch failures are swallowed and produce an empty list", async () => {
    fetchRegistryMock.mockRejectedValueOnce(new Error("net"))
    fetchSkillsShMock.mockRejectedValueOnce(new Error("net"))
    const { result } = renderHook(() => useSkillMarketplace())
    await waitFor(() => expect(result.current.state.loading).toBe(false))
    expect(result.current.state.items).toEqual([])
    expect(result.current.state.error).toBeNull()
  })
})

describe("useSkillMarketplace — token-gated views", () => {
  it("hasToken reflects the settings token", async () => {
    mockSettings = { skillsShToken: "tok" }
    const { result } = renderHook(() => useSkillMarketplace())
    await waitFor(() => expect(result.current.state.loading).toBe(false))
    expect(result.current.hasToken).toBe(true)
  })

  it("leaderboard view fetches page 0 and exposes hasMore", async () => {
    fetchLeaderboardMock.mockResolvedValue({
      items: [sampleItem({ id: "lb-1" })],
      hasMore: true,
    })
    const { result } = renderHook(() => useSkillMarketplace())
    await waitFor(() => expect(result.current.state.loading).toBe(false))
    await act(async () => {
      result.current.setView("trending")
    })
    await waitFor(() => expect(result.current.state.items.map((i) => i.id)).toEqual(["lb-1"]))
    expect(result.current.state.hasMore).toBe(true)
    expect(fetchLeaderboardMock).toHaveBeenCalledWith("trending", 0, 50)
  })

  it("loadMore appends the next page and dedupes ids", async () => {
    fetchLeaderboardMock.mockResolvedValue({
      items: [sampleItem({ id: "lb-1" })],
      hasMore: true,
    })
    const { result } = renderHook(() => useSkillMarketplace())
    await waitFor(() => expect(result.current.state.loading).toBe(false))
    await act(async () => {
      result.current.setView("hot")
    })
    await waitFor(() => expect(result.current.state.items).toHaveLength(1))
    fetchLeaderboardMock.mockResolvedValueOnce({
      items: [sampleItem({ id: "lb-1" }), sampleItem({ id: "lb-2" })],
      hasMore: false,
    })
    await act(async () => {
      await result.current.loadMore()
    })
    expect(result.current.state.items.map((i) => i.id)).toEqual(["lb-1", "lb-2"])
    expect(result.current.state.hasMore).toBe(false)
    expect(fetchLeaderboardMock).toHaveBeenLastCalledWith("hot", 1, 50)
  })

  it("curated view flattens owners into items and exposes the groups", async () => {
    fetchCuratedMock.mockResolvedValue([
      { owner: "vercel-labs", totalInstalls: 9, items: [sampleItem({ id: "c-1" })] },
    ])
    const { result } = renderHook(() => useSkillMarketplace())
    await waitFor(() => expect(result.current.state.loading).toBe(false))
    await act(async () => {
      result.current.setView("curated")
    })
    await waitFor(() => expect(result.current.state.items.map((i) => i.id)).toEqual(["c-1"]))
    expect(result.current.curated).toHaveLength(1)
    expect(result.current.curated[0].owner).toBe("vercel-labs")
  })

  it("a token rejection marks tokenError instead of crashing", async () => {
    fetchLeaderboardMock.mockRejectedValue(new SkillsShTokenError("expired"))
    const { result } = renderHook(() => useSkillMarketplace())
    await waitFor(() => expect(result.current.state.loading).toBe(false))
    await act(async () => {
      result.current.setView("all-time")
    })
    await waitFor(() => expect(result.current.state.tokenError).toBe(true))
    expect(result.current.state.items).toEqual([])
  })
})

describe("useSkillMarketplace — loadMore edge cases", () => {
  it("loadMore is a no-op in search and curated views", async () => {
    const { result } = renderHook(() => useSkillMarketplace())
    await waitFor(() => expect(result.current.state.loading).toBe(false))
    await act(async () => {
      await result.current.loadMore()
    })
    expect(fetchLeaderboardMock).not.toHaveBeenCalled()
  })

  it("loadMore failures surface as state.error (token errors flagged)", async () => {
    fetchLeaderboardMock.mockResolvedValueOnce({
      items: [sampleItem({ id: "lb-1" })],
      hasMore: true,
    })
    const { result } = renderHook(() => useSkillMarketplace())
    await waitFor(() => expect(result.current.state.loading).toBe(false))
    await act(async () => {
      result.current.setView("trending")
    })
    await waitFor(() => expect(result.current.state.items).toHaveLength(1))
    fetchLeaderboardMock.mockRejectedValueOnce(new SkillsShTokenError("expired"))
    await act(async () => {
      await result.current.loadMore()
    })
    expect(result.current.state.error).toBe("expired")
    expect(result.current.state.tokenError).toBe(true)
    expect(result.current.state.loadingMore).toBe(false)
  })

  it("a hard refresh failure lands in state.error", async () => {
    fetchLeaderboardMock.mockRejectedValue(new Error("offline"))
    const { result } = renderHook(() => useSkillMarketplace())
    await waitFor(() => expect(result.current.state.loading).toBe(false))
    await act(async () => {
      result.current.setView("all-time")
    })
    await waitFor(() => expect(result.current.state.error).toBe("offline"))
    expect(result.current.state.tokenError).toBe(false)
  })
})

describe("useSkillMarketplace — install/uninstall + installed set", () => {
  it("uninstall toggles installingId and delegates", async () => {
    const { result } = renderHook(() => useSkillMarketplace())
    await waitFor(() => expect(result.current.state.loading).toBe(false))
    await act(async () => {
      await result.current.uninstall(sampleItem({ id: "u-1" }))
    })
    expect(uninstallMock).toHaveBeenCalled()
    expect(result.current.installingId).toBeNull()
  })

  it("install/uninstall toggles installingId", async () => {
    let resolveInstall: () => void = () => undefined
    installMock.mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          resolveInstall = () => r()
        })
    )
    const { result } = renderHook(() => useSkillMarketplace())
    await waitFor(() => expect(result.current.state.loading).toBe(false))
    let installPromise!: Promise<void>
    act(() => {
      installPromise = result.current.install(sampleItem({ id: "z" }))
    })
    expect(result.current.installingId).toBe("z")
    await act(async () => {
      resolveInstall()
      await installPromise
    })
    expect(result.current.installingId).toBeNull()
  })

  it("derives installed set from useLiveQuery's canonicalIds", async () => {
    liveQueryMock.mockReturnValue([{ id: "1", canonicalId: "canon-1" }, { id: "2" }])
    const { result } = renderHook(() => useSkillMarketplace())
    await waitFor(() => expect(result.current.state.loading).toBe(false))
    expect(Array.from(result.current.installed)).toEqual(["canon-1"])
  })
})

describe("useSkillMarketplace — lazy audit + file tree", () => {
  it("fetchAudit caches per item id and stores the result", async () => {
    fetchAuditMock.mockResolvedValue({ providers: [], worstRisk: "safe" })
    const { result } = renderHook(() => useSkillMarketplace())
    await waitFor(() => expect(result.current.state.loading).toBe(false))
    const item = sampleItem({ id: "a-1" })
    act(() => {
      result.current.fetchAudit(item)
    })
    await waitFor(() =>
      expect(result.current.audit("a-1")).toEqual({ providers: [], worstRisk: "safe" })
    )
    act(() => {
      result.current.fetchAudit(item)
    })
    expect(fetchAuditMock).toHaveBeenCalledTimes(1)
  })

  it("fetchAudit ignores registry items", async () => {
    const { result } = renderHook(() => useSkillMarketplace())
    await waitFor(() => expect(result.current.state.loading).toBe(false))
    act(() => {
      result.current.fetchAudit(sampleItem({ id: "r-1", source: "registry" }))
    })
    expect(fetchAuditMock).not.toHaveBeenCalled()
    expect(result.current.audit("r-1")).toBeUndefined()
  })

  it("fetchFileTree builds the preview tree from the snapshot", async () => {
    fetchDetailMock.mockResolvedValue({
      files: [
        { path: "SKILL.md", contents: "x" },
        { path: "scripts/run.sh", contents: "y" },
      ],
    })
    const { result } = renderHook(() => useSkillMarketplace())
    await waitFor(() => expect(result.current.state.loading).toBe(false))
    act(() => {
      result.current.fetchFileTree(sampleItem({ id: "f-1" }))
    })
    await waitFor(() => {
      const tree = result.current.fileTree("f-1")
      expect(Array.isArray(tree) && tree.length === 2).toBe(true)
    })
  })

  it("audit/file fetch failures resolve to null/empty instead of throwing", async () => {
    fetchAuditMock.mockRejectedValue(new Error("net"))
    fetchDetailMock.mockRejectedValue(new Error("net"))
    const { result } = renderHook(() => useSkillMarketplace())
    await waitFor(() => expect(result.current.state.loading).toBe(false))
    act(() => {
      result.current.fetchAudit(sampleItem({ id: "a-err" }))
      result.current.fetchFileTree(sampleItem({ id: "f-err" }))
    })
    await waitFor(() => expect(result.current.audit("a-err")).toBeNull())
    await waitFor(() => expect(result.current.fileTree("f-err")).toEqual([]))
  })
})
