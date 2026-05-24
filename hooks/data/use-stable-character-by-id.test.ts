import { renderHook } from "@testing-library/react"
import { useStableCharacterById } from "./use-stable-character-by-id"
import type { Character } from "@/lib/claude/types"

describe("useStableCharacterById", () => {
  const alice: Character = { id: "a", name: "Alice" } as Character
  const bob: Character = { id: "b", name: "Bob" } as Character

  it("returns an empty Map for undefined input", () => {
    const { result } = renderHook(() => useStableCharacterById(undefined))
    expect(result.current.size).toBe(0)
  })

  it("returns an empty Map for empty array", () => {
    const { result } = renderHook(() => useStableCharacterById([]))
    expect(result.current.size).toBe(0)
  })

  it("builds a correct lookup Map", () => {
    const { result } = renderHook(() => useStableCharacterById([alice, bob]))
    expect(result.current.get("a")).toBe(alice)
    expect(result.current.get("b")).toBe(bob)
    expect(result.current.get("c")).toBeUndefined()
  })

  it("returns the same Map reference when the list has the same ids", () => {
    const { result, rerender } = renderHook(({ list }) => useStableCharacterById(list), {
      initialProps: { list: [alice, bob] as Character[] },
    })
    const first = result.current

    // New array instance, same content
    rerender({ list: [{ ...alice }, { ...bob }] as Character[] })
    expect(result.current).toBe(first)
    expect(result.current.get("a")).toEqual(alice)
    expect(result.current.get("b")).toEqual(bob)
  })

  it("returns a new Map when a character id changes", () => {
    const { result, rerender } = renderHook(({ list }) => useStableCharacterById(list), {
      initialProps: { list: [alice] as Character[] },
    })
    const first = result.current

    const charlie: Character = { id: "c", name: "Charlie" } as Character
    rerender({ list: [charlie] as Character[] })
    expect(result.current).not.toBe(first)
    expect(result.current.get("c")).toBe(charlie)
  })

  it("returns a new Map when the order changes", () => {
    const { result, rerender } = renderHook(({ list }) => useStableCharacterById(list), {
      initialProps: { list: [alice, bob] as Character[] },
    })
    const first = result.current

    rerender({ list: [bob, alice] as Character[] })
    expect(result.current).not.toBe(first)
  })

  it("returns a new Map when a character is added", () => {
    const { result, rerender } = renderHook(({ list }) => useStableCharacterById(list), {
      initialProps: { list: [alice] as Character[] },
    })
    const first = result.current

    rerender({ list: [alice, bob] as Character[] })
    expect(result.current).not.toBe(first)
    expect(result.current.get("b")).toBe(bob)
  })

  it("returns a new Map when a character is removed", () => {
    const { result, rerender } = renderHook(({ list }) => useStableCharacterById(list), {
      initialProps: { list: [alice, bob] as Character[] },
    })
    const first = result.current

    rerender({ list: [alice] as Character[] })
    expect(result.current).not.toBe(first)
    expect(result.current.has("b")).toBe(false)
  })
})
