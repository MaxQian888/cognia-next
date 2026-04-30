/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react"

const fetchRegistryMock = jest.fn()
const fetchSkillsMpMock = jest.fn()
const isSkillsMpEnabledMock = jest.fn().mockReturnValue(true)
const installMock = jest.fn()
const uninstallMock = jest.fn()
const listInstalledMock = jest.fn().mockResolvedValue([])
const liveQueryMock = jest.fn()

jest.mock("@/lib/skills/marketplace-registry", () => ({
  fetchRegistryItems: () => fetchRegistryMock(),
}))

jest.mock("@/lib/skills/marketplace-skillsmp", () => ({
  fetchSkillsMpItems: (q: unknown) => fetchSkillsMpMock(q),
  isSkillsMpEnabled: () => isSkillsMpEnabledMock(),
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

import { useSkillMarketplace } from "./use-skill-marketplace"

beforeEach(() => {
  fetchRegistryMock.mockReset().mockResolvedValue([])
  fetchSkillsMpMock.mockReset().mockResolvedValue([])
  isSkillsMpEnabledMock.mockReset().mockReturnValue(true)
  installMock.mockReset().mockResolvedValue(undefined)
  uninstallMock.mockReset().mockResolvedValue(undefined)
  listInstalledMock.mockReset().mockResolvedValue([])
  liveQueryMock.mockReset().mockReturnValue([])
})

const sampleItem = (overrides: Record<string, unknown> = {}): never =>
  ({
    id: "i-1",
    name: "Item",
    description: "desc",
    tags: ["a"],
    ...overrides,
  }) as never

describe("useSkillMarketplace", () => {
  it("loads registry + skillsmp on mount and merges them", async () => {
    fetchRegistryMock.mockResolvedValueOnce([sampleItem({ id: "r-1", name: "R1" })])
    fetchSkillsMpMock.mockResolvedValueOnce([sampleItem({ id: "m-1", name: "M1" })])
    const { result } = renderHook(() => useSkillMarketplace())
    await waitFor(() => expect(result.current.state.loading).toBe(false))
    expect(result.current.state.items.map((i) => i.id)).toEqual(["r-1", "m-1"])
  })

  it("filters by query (name / description / tags)", async () => {
    const items = [
      sampleItem({ id: "x", name: "Foo", description: "" }),
      sampleItem({ id: "y", name: "Bar", description: "world" }),
    ]
    fetchRegistryMock.mockResolvedValue(items)
    const { result } = renderHook(() => useSkillMarketplace())
    await waitFor(() => expect(result.current.state.loading).toBe(false))
    await act(async () => {
      result.current.setQuery("world")
    })
    await waitFor(() => expect(result.current.state.items.map((i) => i.id)).toEqual(["y"]))
  })

  it("source filter: registry only excludes skillsmp", async () => {
    // Default mocks (returning []) cover the initial mount.
    const { result } = renderHook(() => useSkillMarketplace())
    await waitFor(() => expect(result.current.state.loading).toBe(false))
    fetchRegistryMock.mockResolvedValueOnce([sampleItem({ id: "r2" })])
    await act(async () => {
      result.current.setSource("registry")
    })
    await waitFor(() => expect(result.current.state.items.map((i) => i.id)).toEqual(["r2"]))
    expect(fetchSkillsMpMock).toHaveBeenCalledTimes(1) // only the initial mount
  })

  it("source filter: skillsmp only excludes registry", async () => {
    const { result } = renderHook(() => useSkillMarketplace())
    await waitFor(() => expect(result.current.state.loading).toBe(false))
    fetchSkillsMpMock.mockResolvedValueOnce([sampleItem({ id: "m2" })])
    await act(async () => {
      result.current.setSource("skillsmp")
    })
    await waitFor(() => expect(result.current.state.items.map((i) => i.id)).toEqual(["m2"]))
  })

  it("fetch failures are swallowed and produce an empty list", async () => {
    fetchRegistryMock.mockRejectedValueOnce(new Error("net"))
    fetchSkillsMpMock.mockRejectedValueOnce(new Error("net"))
    const { result } = renderHook(() => useSkillMarketplace())
    await waitFor(() => expect(result.current.state.loading).toBe(false))
    expect(result.current.state.items).toEqual([])
    expect(result.current.state.error).toBeNull()
  })

  it("install/uninstall toggles installingId", async () => {
    fetchRegistryMock.mockResolvedValueOnce([])
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
    let resolveUninstall: () => void = () => undefined
    uninstallMock.mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          resolveUninstall = () => r()
        })
    )
    let uninstallPromise!: Promise<void>
    act(() => {
      uninstallPromise = result.current.uninstall(sampleItem({ id: "z" }))
    })
    expect(result.current.installingId).toBe("z")
    await act(async () => {
      resolveUninstall()
      await uninstallPromise
    })
    expect(result.current.installingId).toBeNull()
  })

  it("derives installed set from useLiveQuery's canonicalIds", async () => {
    liveQueryMock.mockReturnValue([{ id: "1", canonicalId: "canon-1" }, { id: "2" }])
    fetchRegistryMock.mockResolvedValueOnce([])
    const { result } = renderHook(() => useSkillMarketplace())
    await waitFor(() => expect(result.current.state.loading).toBe(false))
    expect(Array.from(result.current.installed)).toEqual(["canon-1"])
  })

  it("isSkillsMpEnabled is exposed and refresh re-runs the fetch", async () => {
    fetchRegistryMock.mockResolvedValueOnce([])
    const { result } = renderHook(() => useSkillMarketplace())
    await waitFor(() => expect(result.current.state.loading).toBe(false))
    expect(result.current.isSkillsMpEnabled).toBe(true)
    fetchRegistryMock.mockResolvedValueOnce([sampleItem({ id: "r-refresh" })])
    await act(async () => {
      await result.current.refresh()
    })
    await waitFor(() => expect(result.current.state.items.map((i) => i.id)).toEqual(["r-refresh"]))
  })
})
