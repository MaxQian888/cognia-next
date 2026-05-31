/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"

import { favoriteKey, useDiscoverFavorites } from "./use-discover-favorites"
import { useSettingsStore } from "@/stores/settings/settings-store"

const saveMock = jest.fn(async (_patch?: { discoverFavorites?: string[] }) => {})

beforeEach(() => {
  saveMock.mockClear()
  useSettingsStore.setState({
    settings: { discoverFavorites: ["character:abc"] } as never,
    save: saveMock as never,
  })
})

const lastSaved = () =>
  saveMock.mock.calls[saveMock.mock.calls.length - 1]?.[0]?.discoverFavorites as string[]

describe("favoriteKey", () => {
  it("namespaces by kind so ids cannot collide", () => {
    expect(favoriteKey("character", "x")).toBe("character:x")
    expect(favoriteKey("plugin", "x")).not.toBe(favoriteKey("character", "x"))
  })
})

describe("useDiscoverFavorites", () => {
  it("reports favorite membership by kind+id", () => {
    const { result } = renderHook(() => useDiscoverFavorites())
    expect(result.current.isFavorite("character", "abc")).toBe(true)
    expect(result.current.isFavorite("plugin", "abc")).toBe(false)
  })

  it("exposes the favorite keys as a set", () => {
    const { result } = renderHook(() => useDiscoverFavorites())
    expect(result.current.favoriteKeys.has("character:abc")).toBe(true)
  })

  it("adds a favorite when toggling an unfavorited item", async () => {
    const { result } = renderHook(() => useDiscoverFavorites())
    await act(async () => {
      await result.current.toggleFavorite("skill", "s1")
    })
    expect(lastSaved()).toEqual(["character:abc", "skill:s1"])
  })

  it("removes a favorite when toggling a favorited item", async () => {
    const { result } = renderHook(() => useDiscoverFavorites())
    await act(async () => {
      await result.current.toggleFavorite("character", "abc")
    })
    expect(lastSaved()).toEqual([])
  })

  it("treats missing settings as an empty favorite set", async () => {
    useSettingsStore.setState({ settings: {} as never })
    const { result } = renderHook(() => useDiscoverFavorites())
    expect(result.current.isFavorite("character", "abc")).toBe(false)
    await act(async () => {
      await result.current.toggleFavorite("team", "t1")
    })
    expect(lastSaved()).toEqual(["team:t1"])
  })
})
