/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"

import { useDiscoverView } from "./use-discover-view"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { DEFAULT_DISCOVER_VIEW } from "@/lib/discover/categories"

const saveMock = jest.fn(async (_patch?: { discoverViewByCategory?: Record<string, string> }) => {})

beforeEach(() => {
  saveMock.mockClear()
  useSettingsStore.setState({
    settings: { discoverViewByCategory: { characters: "list" } } as never,
    save: saveMock as never,
  })
})

const lastSaved = () =>
  saveMock.mock.calls[saveMock.mock.calls.length - 1]?.[0]?.discoverViewByCategory as Record<
    string,
    string
  >

describe("useDiscoverView", () => {
  it("returns the stored mode for a category", () => {
    const { result } = renderHook(() => useDiscoverView())
    expect(result.current.view("characters")).toBe("list")
  })

  it("falls back to the default mode for an unset category", () => {
    const { result } = renderHook(() => useDiscoverView())
    expect(result.current.view("plugins")).toBe(DEFAULT_DISCOVER_VIEW)
  })

  it("persists a per-category mode without clobbering others", async () => {
    const { result } = renderHook(() => useDiscoverView())
    await act(async () => {
      await result.current.setView("plugins", "compact")
    })
    expect(lastSaved()).toEqual({ characters: "list", plugins: "compact" })
  })

  it("treats missing settings as all-default", async () => {
    useSettingsStore.setState({ settings: {} as never })
    const { result } = renderHook(() => useDiscoverView())
    expect(result.current.view("characters")).toBe(DEFAULT_DISCOVER_VIEW)
    await act(async () => {
      await result.current.setView("teams", "grid")
    })
    expect(lastSaved()).toEqual({ teams: "grid" })
  })

  it("uses discoverDefaults.view as the fallback for categories without an override", () => {
    useSettingsStore.setState({
      settings: {
        discoverViewByCategory: { characters: "list" },
        discoverDefaults: { view: "compact" },
      } as never,
    })
    const { result } = renderHook(() => useDiscoverView())
    // Explicit per-category override still wins.
    expect(result.current.view("characters")).toBe("list")
    // Everything else falls back to the global default, not the registry one.
    expect(result.current.view("plugins")).toBe("compact")
  })
})
