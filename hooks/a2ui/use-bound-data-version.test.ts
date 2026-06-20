import { renderHook } from "@testing-library/react"
import { useBoundDataVersion } from "./use-bound-data-version"
import { setValueByPath } from "@/lib/a2ui/data-model"

describe("useBoundDataVersion", () => {
  it("does not bump on mount and returns a stable number", () => {
    const { result, rerender } = renderHook(() => useBoundDataVersion(["/a"], { a: 1 }))
    const v0 = result.current
    expect(typeof v0).toBe("number")
    rerender()
    expect(result.current).toBe(v0)
  })

  it("does not bump when an unbound path changes (structural sharing)", () => {
    let model: Record<string, unknown> = { a: 1, b: { x: 1 } }
    const { result, rerender } = renderHook(() => useBoundDataVersion(["/a"], model))
    const v1 = result.current

    // Mutate a DIFFERENT path — structural sharing keeps /a's reference stable.
    model = setValueByPath(model, "/b/x", 2)
    rerender()
    expect(result.current).toBe(v1)
  })

  it("bumps when a bound path changes", () => {
    let model: Record<string, unknown> = { a: 1, b: 2 }
    const { result, rerender } = renderHook(() => useBoundDataVersion(["/a"], model))
    const v1 = result.current

    model = setValueByPath(model, "/a", 99)
    rerender()
    expect(result.current).toBe(v1 + 1)
  })

  it("bumps when any descendant of a bound container changes", () => {
    let model: Record<string, unknown> = { rows: [{ v: 1 }, { v: 2 }] }
    const { result, rerender } = renderHook(() => useBoundDataVersion(["/rows"], model))
    const v1 = result.current

    // A deep change reseats the /rows reference under structural sharing.
    model = setValueByPath(model, "/rows/0/v", 5)
    rerender()
    expect(result.current).toBe(v1 + 1)
  })

  it("bumps when the set of bound paths changes length", () => {
    const model = { a: 1, b: 2 }
    const { result, rerender } = renderHook(({ paths }) => useBoundDataVersion(paths, model), {
      initialProps: { paths: ["/a"] },
    })
    const v1 = result.current
    rerender({ paths: ["/a", "/b"] })
    expect(result.current).toBe(v1 + 1)
  })

  it("is stable across re-renders with no data change", () => {
    const model = { a: 1 }
    const { result, rerender } = renderHook(() => useBoundDataVersion(["/a"], model))
    const v1 = result.current
    rerender()
    rerender()
    expect(result.current).toBe(v1)
  })

  it("treats an empty path list as permanently stable", () => {
    let model: Record<string, unknown> = { a: 1 }
    const { result, rerender } = renderHook(() => useBoundDataVersion([], model))
    const v1 = result.current
    model = setValueByPath(model, "/a", 2)
    rerender()
    expect(result.current).toBe(v1)
  })
})
