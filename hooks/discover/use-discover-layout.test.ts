/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"

import { useDiscoverLayout } from "./use-discover-layout"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { DEFAULT_DISCOVER_LAYOUT, DISCOVER_CATEGORIES } from "@/lib/discover/categories"

const saveMock = jest.fn(
  async (_patch?: { discoverLayout?: { pinned: string[]; hidden: string[] } }) => {}
)

beforeEach(() => {
  saveMock.mockClear()
  useSettingsStore.setState({
    settings: { discoverLayout: { pinned: ["skills", "characters"], hidden: [] } } as never,
    save: saveMock as never,
  })
})

const lastSaved = () =>
  saveMock.mock.calls[saveMock.mock.calls.length - 1]?.[0]?.discoverLayout as {
    pinned: string[]
    hidden: string[]
  }

describe("useDiscoverLayout", () => {
  it("resolves pinned/overflow/hidden from settings", () => {
    const { result } = renderHook(() => useDiscoverLayout())
    expect(result.current.resolved.pinned.map((i) => i.id)).toEqual(["skills", "characters"])
    expect(result.current.resolved.overflow.map((i) => i.id)).toContain("plugins")
    expect(result.current.resolved.hidden).toEqual([])
  })

  it("exposes the first visible category as the default", () => {
    const { result } = renderHook(() => useDiscoverLayout())
    expect(result.current.defaultCategory).toBe("skills")
  })

  it("falls back to the default layout when unset", () => {
    useSettingsStore.setState({ settings: {} as never })
    const { result } = renderHook(() => useDiscoverLayout())
    expect(result.current.layout).toEqual(DEFAULT_DISCOVER_LAYOUT)
    expect(result.current.defaultCategory).toBe(DISCOVER_CATEGORIES[0].id)
  })

  it("pins an item to the end and unhides it", async () => {
    useSettingsStore.setState({
      settings: { discoverLayout: { pinned: ["skills"], hidden: ["plugins"] } } as never,
    })
    const { result } = renderHook(() => useDiscoverLayout())
    await act(async () => {
      await result.current.pin("plugins")
    })
    expect(lastSaved()).toEqual({ pinned: ["skills", "plugins"], hidden: [] })
  })

  it("does not duplicate an already-pinned id", async () => {
    const { result } = renderHook(() => useDiscoverLayout())
    await act(async () => {
      await result.current.pin("skills")
    })
    expect(lastSaved().pinned).toEqual(["skills", "characters"])
  })

  it("unpins an item (it drops to overflow)", async () => {
    const { result } = renderHook(() => useDiscoverLayout())
    await act(async () => {
      await result.current.unpin("characters")
    })
    expect(lastSaved()).toEqual({ pinned: ["skills"], hidden: [] })
  })

  it("hides an item and unpins it", async () => {
    const { result } = renderHook(() => useDiscoverLayout())
    await act(async () => {
      await result.current.hide("characters")
    })
    expect(lastSaved()).toEqual({ pinned: ["skills"], hidden: ["characters"] })
  })

  it("shows a hidden item", async () => {
    useSettingsStore.setState({
      settings: { discoverLayout: { pinned: [], hidden: ["plugins", "teams"] } } as never,
    })
    const { result } = renderHook(() => useDiscoverLayout())
    await act(async () => {
      await result.current.show("plugins")
    })
    expect(lastSaved()).toEqual({ pinned: [], hidden: ["teams"] })
  })

  it("reorders pinned, dropping unknown ids", async () => {
    const { result } = renderHook(() => useDiscoverLayout())
    await act(async () => {
      await result.current.reorderPinned(["characters", "skills", "ghost"])
    })
    expect(lastSaved().pinned).toEqual(["characters", "skills"])
  })

  it("resets to the default layout", async () => {
    const { result } = renderHook(() => useDiscoverLayout())
    await act(async () => {
      await result.current.reset()
    })
    expect(lastSaved()).toEqual(DEFAULT_DISCOVER_LAYOUT)
  })

  it("keeps layout/callback identity when an unrelated setting changes", () => {
    const { result, rerender } = renderHook(() => useDiscoverLayout())
    const firstLayout = result.current.layout
    const firstPin = result.current.pin
    const existing = (useSettingsStore.getState().settings as { discoverLayout: unknown })
      .discoverLayout
    act(() => {
      useSettingsStore.setState({
        settings: { theme: "dark", discoverLayout: existing } as never,
      })
    })
    rerender()
    expect(result.current.layout).toBe(firstLayout)
    expect(result.current.pin).toBe(firstPin)
  })
})
