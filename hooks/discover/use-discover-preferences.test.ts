/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"

import { useDiscoverPreferences } from "./use-discover-preferences"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { DEFAULT_DISCOVER_VIEW } from "@/lib/discover/categories"

const saveMock = jest.fn(
  async (_patch?: { discoverDefaults?: { landingCategory?: string; view?: string } }) => {}
)

beforeEach(() => {
  saveMock.mockClear()
  useSettingsStore.setState({
    settings: { discoverDefaults: { landingCategory: "skills", view: "list" } } as never,
    save: saveMock as never,
  })
})

const lastSaved = () => saveMock.mock.calls[saveMock.mock.calls.length - 1]?.[0]?.discoverDefaults

describe("useDiscoverPreferences", () => {
  it("reads persisted landing category + view", () => {
    const { result } = renderHook(() => useDiscoverPreferences())
    expect(result.current.preferences).toEqual({ landingCategory: "skills", view: "list" })
    expect(result.current.isDefault).toBe(false)
  })

  it("treats missing defaults as auto landing + registry view", () => {
    useSettingsStore.setState({ settings: {} as never })
    const { result } = renderHook(() => useDiscoverPreferences())
    expect(result.current.preferences).toEqual({
      landingCategory: null,
      view: DEFAULT_DISCOVER_VIEW,
    })
    expect(result.current.isDefault).toBe(true)
  })

  it("ignores an invalid stored landing category / view", () => {
    useSettingsStore.setState({
      settings: { discoverDefaults: { landingCategory: "bogus", view: "table" } } as never,
    })
    const { result } = renderHook(() => useDiscoverPreferences())
    expect(result.current.preferences).toEqual({
      landingCategory: null,
      view: DEFAULT_DISCOVER_VIEW,
    })
  })

  it("accepts the favorites pseudo-category as a landing", () => {
    useSettingsStore.setState({
      settings: { discoverDefaults: { landingCategory: "favorites" } } as never,
    })
    const { result } = renderHook(() => useDiscoverPreferences())
    expect(result.current.preferences.landingCategory).toBe("favorites")
  })

  it("persists a landing category without clobbering the view", async () => {
    const { result } = renderHook(() => useDiscoverPreferences())
    await act(async () => {
      await result.current.setLandingCategory("plugins")
    })
    expect(lastSaved()).toEqual({ landingCategory: "plugins", view: "list" })
  })

  it("clears the landing category by dropping the key", async () => {
    const { result } = renderHook(() => useDiscoverPreferences())
    await act(async () => {
      await result.current.setLandingCategory(null)
    })
    expect(lastSaved()).toEqual({ landingCategory: undefined, view: "list" })
  })

  it("persists a default view without clobbering the landing", async () => {
    const { result } = renderHook(() => useDiscoverPreferences())
    await act(async () => {
      await result.current.setDefaultView("compact")
    })
    expect(lastSaved()).toEqual({ landingCategory: "skills", view: "compact" })
  })

  it("reset wipes both defaults", async () => {
    const { result } = renderHook(() => useDiscoverPreferences())
    await act(async () => {
      await result.current.reset()
    })
    expect(lastSaved()).toEqual({})
  })

  it("seeds a fresh discoverDefaults object when none exists yet", async () => {
    useSettingsStore.setState({ settings: {} as never, save: saveMock as never })
    const { result } = renderHook(() => useDiscoverPreferences())
    await act(async () => {
      await result.current.setDefaultView("grid")
    })
    expect(lastSaved()).toEqual({ view: "grid" })
    await act(async () => {
      await result.current.setLandingCategory("teams")
    })
    expect(lastSaved()).toEqual({ landingCategory: "teams" })
  })
})
