/**
 * @jest-environment jsdom
 */
import { act, render } from "@testing-library/react"
import { useRef } from "react"

import type { ElementRect } from "@/lib/browser/protocol"
import { useElementRect } from "./use-element-rect"

let rectValue = { left: 0, top: 0, width: 0, height: 0 }
const origRAF = global.requestAnimationFrame
const origCAF = global.cancelAnimationFrame

beforeAll(() => {
  Element.prototype.getBoundingClientRect = jest.fn(
    () =>
      ({
        left: rectValue.left,
        top: rectValue.top,
        width: rectValue.width,
        height: rectValue.height,
        right: rectValue.left + rectValue.width,
        bottom: rectValue.top + rectValue.height,
        x: rectValue.left,
        y: rectValue.top,
        toJSON: () => ({}),
      }) as DOMRect
  )
  // Synchronous rAF so the resize/scroll path measures inline.
  global.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    cb(0)
    return 1
  }) as unknown as typeof requestAnimationFrame
  global.cancelAnimationFrame = (() => {}) as unknown as typeof cancelAnimationFrame
})

afterAll(() => {
  global.requestAnimationFrame = origRAF
  global.cancelAnimationFrame = origCAF
})

function Probe({
  onChange,
  trackState,
}: {
  onChange: (r: ElementRect) => void
  trackState?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const rect = useElementRect(ref, onChange, { trackState })
  return <div ref={ref} data-rect={rect ? `${rect.width}x${rect.height}` : "none"} />
}

it("measures on mount and reports the rounded rect", () => {
  rectValue = { left: 10.4, top: 20.6, width: 100, height: 40 }
  const onChange = jest.fn()
  const { container } = render(<Probe onChange={onChange} />)
  expect(onChange).toHaveBeenCalledWith({ x: 10, y: 21, width: 100, height: 40 })
  expect(container.firstChild).toHaveAttribute("data-rect", "100x40")
})

it("re-measures on window resize when the rect changes", () => {
  rectValue = { left: 0, top: 0, width: 50, height: 50 }
  const onChange = jest.fn()
  render(<Probe onChange={onChange} />)
  onChange.mockClear()
  rectValue = { left: 0, top: 0, width: 80, height: 50 }
  act(() => {
    window.dispatchEvent(new Event("resize"))
  })
  expect(onChange).toHaveBeenCalledWith({ x: 0, y: 0, width: 80, height: 50 })
})

it("re-measures when an ancestor layout mutation moves the element without resizing it", async () => {
  rectValue = { left: 0, top: 0, width: 80, height: 50 }
  const onChange = jest.fn()
  const { container } = render(<Probe onChange={onChange} />)
  onChange.mockClear()

  rectValue = { left: 64, top: 0, width: 80, height: 50 }
  await act(async () => {
    container.setAttribute("data-sidebar-side", "left")
    await Promise.resolve()
  })

  expect(onChange).toHaveBeenCalledWith({ x: 64, y: 0, width: 80, height: 50 })
})

it("skips no-op updates when the rect is unchanged", () => {
  rectValue = { left: 0, top: 0, width: 50, height: 50 }
  const onChange = jest.fn()
  render(<Probe onChange={onChange} />)
  onChange.mockClear()
  act(() => {
    window.dispatchEvent(new Event("scroll", { bubbles: true }))
  })
  expect(onChange).not.toHaveBeenCalled()
})

it("delivers rects via onChange only (no state) when trackState is false", () => {
  rectValue = { left: 0, top: 0, width: 60, height: 30 }
  const onChange = jest.fn()
  const { container } = render(<Probe onChange={onChange} trackState={false} />)
  expect(onChange).toHaveBeenCalledWith({ x: 0, y: 0, width: 60, height: 30 })
  // No state tracked — the returned rect stays null across changes.
  expect(container.firstChild).toHaveAttribute("data-rect", "none")
  rectValue = { left: 0, top: 0, width: 90, height: 30 }
  act(() => {
    window.dispatchEvent(new Event("resize"))
  })
  expect(onChange).toHaveBeenCalledWith({ x: 0, y: 0, width: 90, height: 30 })
  expect(container.firstChild).toHaveAttribute("data-rect", "none")
})

it("works without an onChange callback", () => {
  rectValue = { left: 0, top: 0, width: 12, height: 12 }
  const { container } = render(<Probe onChange={undefined as unknown as () => void} />)
  expect(container.firstChild).toHaveAttribute("data-rect", "12x12")
})
