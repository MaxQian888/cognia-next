/** @jest-environment jsdom */
import { renderHook } from "@testing-library/react"

import { isToolbarSqueezed, useFittedFoldTier } from "./use-fitted-fold-tier"

/** jsdom has no layout: every box is 0×0 unless a test says otherwise. */
function box(
  el: HTMLElement,
  { scroll, client, rect }: { scroll: number; client: number; rect?: number }
): HTMLElement {
  Object.defineProperty(el, "scrollWidth", { configurable: true, value: scroll })
  Object.defineProperty(el, "clientWidth", { configurable: true, value: client })
  el.getBoundingClientRect = () => ({ width: rect ?? client }) as DOMRect
  return el
}

function row(): HTMLElement {
  const root = document.createElement("div")
  document.body.appendChild(root)
  return box(root, { scroll: 400, client: 400 })
}

function label(parent: HTMLElement, width: { scroll: number; client: number }): HTMLElement {
  const chip = document.createElement("button")
  const span = document.createElement("span")
  span.className = "truncate"
  chip.appendChild(span)
  parent.appendChild(chip)
  box(chip, { scroll: width.client, client: width.client })
  return box(span, width)
}

afterEach(() => {
  document.body.innerHTML = ""
})

describe("isToolbarSqueezed", () => {
  it("is false when every label fits", () => {
    const root = row()
    label(root, { scroll: 40, client: 40 })
    expect(isToolbarSqueezed(root)).toBe(false)
  })

  it("is true when the row itself overflows", () => {
    const root = box(document.createElement("div"), { scroll: 420, client: 400 })
    expect(isToolbarSqueezed(root)).toBe(true)
  })

  it("is true when a label is clipped below any cap", () => {
    const root = row()
    label(root, { scroll: 48, client: 11 })
    expect(isToolbarSqueezed(root)).toBe(true)
  })

  it("ignores a label clipped by its chip's own max-width cap", () => {
    const root = row()
    const span = label(root, { scroll: 240, client: 160 })
    const chip = span.parentElement as HTMLElement
    chip.style.maxWidth = "176px"
    box(chip, { scroll: 176, client: 176 })
    expect(isToolbarSqueezed(root)).toBe(false)
  })

  it("still counts a capped chip that the row squeezed below its cap", () => {
    const root = row()
    const span = label(root, { scroll: 240, client: 40 })
    const chip = span.parentElement as HTMLElement
    chip.style.maxWidth = "176px"
    box(chip, { scroll: 64, client: 64 })
    expect(isToolbarSqueezed(root)).toBe(true)
  })

  it("treats a percentage cap as a share of the row, not a design cap", () => {
    const root = row()
    const span = label(root, { scroll: 240, client: 40 })
    const chip = span.parentElement as HTMLElement
    chip.style.maxWidth = "50%"
    expect(isToolbarSqueezed(root)).toBe(true)
  })
})

describe("useFittedFoldTier", () => {
  it("keeps the threshold tier when nothing is squeezed", () => {
    const root = row()
    label(root, { scroll: 40, client: 40 })
    const { result } = renderHook(() => useFittedFoldTier({ current: root }, 792, "a"))
    expect(result.current).toBe(0)
  })

  it("does not judge an unmeasured row", () => {
    const root = row()
    label(root, { scroll: 48, client: 11 })
    const { result } = renderHook(() => useFittedFoldTier({ current: root }, 0, "a"))
    expect(result.current).toBe(0)
  })

  it("steps down one rung per squeezed commit until the row fits", () => {
    const root = row()
    const span = label(root, { scroll: 48, client: 11 })
    let squeezedRenders = 2
    const { result } = renderHook(() => {
      const tier = useFittedFoldTier({ current: root }, 792, "a")
      // The row "fits" once two extra rungs have folded enough of it.
      if (tier >= 2 && squeezedRenders > 0) {
        squeezedRenders = 0
        box(span, { scroll: 48, client: 48 })
      }
      return tier
    })
    expect(result.current).toBe(2)
  })

  it("stops at the last rung", () => {
    const root = row()
    label(root, { scroll: 48, client: 11 })
    const { result } = renderHook(() => useFittedFoldTier({ current: root }, 350, "a"))
    expect(result.current).toBe(4)
  })

  it("starts again from the threshold tier when the width or the roster changes", () => {
    const root = row()
    const span = label(root, { scroll: 48, client: 11 })
    const { result, rerender } = renderHook(
      ({ width, signature }) => useFittedFoldTier({ current: root }, width, signature),
      { initialProps: { width: 792, signature: "a" } }
    )
    expect(result.current).toBe(4)

    box(span, { scroll: 48, client: 48 })
    rerender({ width: 800, signature: "a" })
    expect(result.current).toBe(0)

    box(span, { scroll: 48, client: 11 })
    rerender({ width: 800, signature: "a" })
    expect(result.current).toBe(4)

    box(span, { scroll: 48, client: 48 })
    rerender({ width: 800, signature: "b" })
    expect(result.current).toBe(0)
  })
})
