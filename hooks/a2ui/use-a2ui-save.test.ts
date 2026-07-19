/** @jest-environment jsdom */
import { renderHook, act } from "@testing-library/react"
import { useA2UISave } from "./use-a2ui-save"
import { getAppInstancesCache } from "./app-builder/persistence"
import { upsertApp } from "@/lib/db/a2ui-apps"

jest.mock("@/lib/db/a2ui-apps", () => ({ upsertApp: jest.fn(async () => {}) }))

let mockSurface: unknown = null
jest.mock("@/stores/a2ui", () => ({
  useA2UIStore: {
    getState: () => ({
      getSurface: (id: string) => (id === "s1" ? mockSurface : undefined),
    }),
  },
}))

describe("useA2UISave", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    getAppInstancesCache().clear()
    mockSurface = null
  })

  it("persists the surface tree + data model to Dexie and bumps lastModified", async () => {
    mockSurface = {
      components: { root: { id: "root" } },
      dataModel: { display: "5" },
      rootId: "root",
      catalogId: "cognia-general",
    }
    const cache = getAppInstancesCache()
    cache.set("s1", {
      id: "s1",
      templateId: "calculator",
      name: "Calc",
      createdAt: 1,
      lastModified: 1,
    })

    const { result } = renderHook(() => useA2UISave("s1"))
    let ok = false
    await act(async () => {
      ok = await result.current()
    })

    expect(ok).toBe(true)
    expect(upsertApp).toHaveBeenCalledTimes(1)
    const row = (upsertApp as jest.Mock).mock.calls[0][0]
    expect(row.id).toBe("s1")
    expect(row.components).toEqual({ root: { id: "root" } })
    expect(row.dataModel).toEqual({ display: "5" })
    expect(row.rootId).toBe("root")
    expect(row.lastModified).toBeGreaterThan(1)
    expect(row.updatedAt).toBeGreaterThan(1)
    // the localStorage instance is bumped too
    expect(cache.get("s1")?.lastModified).toBeGreaterThan(1)
  })

  it("returns false and writes nothing when the instance is missing", async () => {
    mockSurface = { components: {}, dataModel: {}, rootId: "root" }
    const { result } = renderHook(() => useA2UISave("s1"))
    let ok = true
    await act(async () => {
      ok = await result.current()
    })
    expect(ok).toBe(false)
    expect(upsertApp).not.toHaveBeenCalled()
  })

  it("returns false when the surface is missing", async () => {
    getAppInstancesCache().set("s1", {
      id: "s1",
      templateId: "t",
      name: "n",
      createdAt: 1,
      lastModified: 1,
    })
    const { result } = renderHook(() => useA2UISave("s1"))
    let ok = true
    await act(async () => {
      ok = await result.current()
    })
    expect(ok).toBe(false)
    expect(upsertApp).not.toHaveBeenCalled()
  })

  it("restores local modification metadata when the durable save fails", async () => {
    mockSurface = {
      components: { root: { id: "root" } },
      dataModel: {},
      rootId: "root",
    }
    const cache = getAppInstancesCache()
    cache.set("s1", {
      id: "s1",
      templateId: "custom",
      name: "Unsaved",
      createdAt: 1,
      lastModified: 10,
    })
    ;(upsertApp as jest.Mock).mockRejectedValueOnce(new Error("built-in is read-only"))

    const { result } = renderHook(() => useA2UISave("s1"))
    await expect(result.current()).rejects.toThrow("built-in is read-only")

    expect(cache.get("s1")?.lastModified).toBe(10)
  })
})
