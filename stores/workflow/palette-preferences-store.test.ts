/**
 * @jest-environment jsdom
 */
import { act } from "@testing-library/react"
import { usePalettePreferencesStore, RECENT_LIMIT } from "./palette-preferences-store"

function reset() {
  act(() => {
    usePalettePreferencesStore.setState({ favoriteNodeKinds: [], recentlyUsedNodeKinds: [] })
  })
}

describe("palette-preferences-store", () => {
  beforeEach(reset)

  it("toggles a favorite on and off", () => {
    const { toggleFavorite, isFavorite } = usePalettePreferencesStore.getState()
    expect(isFavorite("ai.prompt")).toBe(false)
    act(() => toggleFavorite("ai.prompt"))
    expect(usePalettePreferencesStore.getState().favoriteNodeKinds).toEqual(["ai.prompt"])
    expect(usePalettePreferencesStore.getState().isFavorite("ai.prompt")).toBe(true)
    act(() => usePalettePreferencesStore.getState().toggleFavorite("ai.prompt"))
    expect(usePalettePreferencesStore.getState().favoriteNodeKinds).toEqual([])
  })

  it("records recent kinds most-recent-first and de-duplicates", () => {
    const rec = (k: string) => act(() => usePalettePreferencesStore.getState().recordUsed(k))
    rec("a")
    rec("b")
    rec("a") // re-use bumps it back to front
    expect(usePalettePreferencesStore.getState().recentlyUsedNodeKinds).toEqual(["a", "b"])
  })

  it("caps the recent list at RECENT_LIMIT", () => {
    act(() => {
      for (let i = 0; i < RECENT_LIMIT + 5; i++) {
        usePalettePreferencesStore.getState().recordUsed(`k${i}`)
      }
    })
    const recent = usePalettePreferencesStore.getState().recentlyUsedNodeKinds
    expect(recent).toHaveLength(RECENT_LIMIT)
    // Most recent first.
    expect(recent[0]).toBe(`k${RECENT_LIMIT + 4}`)
  })
})
