/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"

import { useDirtyDraft } from "./use-dirty-draft"

interface Form {
  enabled: boolean
  maxDepth: number
  globs: string[]
  rules: Record<string, string>
}

const base: Form = { enabled: false, maxDepth: 2, globs: [], rules: {} }

describe("useDirtyDraft", () => {
  it("starts clean and mirrors the initial values", () => {
    const { result } = renderHook(() => useDirtyDraft("panel-a", base))
    expect(result.current.draft).toEqual(base)
    expect(result.current.isDirty).toBe(false)
    expect(result.current.dirtyKeys).toEqual([])
  })

  it("tracks which fields changed", () => {
    const { result } = renderHook(() => useDirtyDraft("panel-a", base))
    act(() => result.current.setField("maxDepth", 4))
    expect(result.current.isDirty).toBe(true)
    expect(result.current.dirtyKeys).toEqual(["maxDepth"])
    act(() => result.current.patch({ enabled: true }))
    expect([...result.current.dirtyKeys].sort()).toEqual(["enabled", "maxDepth"])
  })

  it("goes clean again when a field is set back to its baseline value", () => {
    const { result } = renderHook(() => useDirtyDraft("panel-a", base))
    act(() => result.current.setField("maxDepth", 4))
    act(() => result.current.setField("maxDepth", 2))
    expect(result.current.isDirty).toBe(false)
  })

  it("compares arrays and objects structurally, not by reference", () => {
    const { result } = renderHook(() => useDirtyDraft("panel-a", base))
    act(() => result.current.setField("globs", []))
    act(() => result.current.setField("rules", {}))
    expect(result.current.isDirty).toBe(false)

    act(() => result.current.setField("globs", ["Bash(*)"]))
    expect(result.current.dirtyKeys).toEqual(["globs"])
  })

  it("does NOT clobber in-flight edits when the initial object changes identity-free", () => {
    // The regression this hook exists for: an unrelated settings save publishes
    // a new object; the user's half-typed value must survive it.
    const { result, rerender } = renderHook(
      ({ initial }: { initial: Form }) => useDirtyDraft("panel-a", initial),
      { initialProps: { initial: base } }
    )
    act(() => result.current.setField("maxDepth", 5))

    rerender({ initial: { ...base, enabled: true } })

    expect(result.current.draft.maxDepth).toBe(5)
    expect(result.current.dirtyKeys).toEqual(["maxDepth"])
  })

  it("re-hydrates when the identity changes — a different thing is being edited", () => {
    const other: Form = { enabled: true, maxDepth: 9, globs: ["x"], rules: {} }
    const { result, rerender } = renderHook(
      ({ id, initial }: { id: string; initial: Form }) => useDirtyDraft(id, initial),
      { initialProps: { id: "panel-a", initial: base } }
    )
    act(() => result.current.setField("maxDepth", 5))

    rerender({ id: "panel-b", initial: other })

    expect(result.current.draft).toEqual(other)
    expect(result.current.isDirty).toBe(false)
  })

  it("discards back to the baseline", () => {
    const { result } = renderHook(() => useDirtyDraft("panel-a", base))
    act(() => result.current.patch({ maxDepth: 5, enabled: true }))
    act(() => result.current.discard())
    expect(result.current.draft).toEqual(base)
    expect(result.current.isDirty).toBe(false)
  })

  it("re-baselines on commit so a saved value is no longer dirty", () => {
    const { result } = renderHook(() => useDirtyDraft("panel-a", base))
    act(() => result.current.setField("maxDepth", 5))
    act(() => result.current.commit())
    expect(result.current.isDirty).toBe(false)
    expect(result.current.baseline.maxDepth).toBe(5)
  })

  it("accepts store-normalised values on commit", () => {
    const { result } = renderHook(() => useDirtyDraft("panel-a", base))
    act(() => result.current.setField("maxDepth", 99))
    // Store clamped it on the way in.
    act(() => result.current.commit({ ...base, maxDepth: 5 }))
    expect(result.current.draft.maxDepth).toBe(5)
    expect(result.current.isDirty).toBe(false)
  })
})
