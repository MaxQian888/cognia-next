/** @jest-environment jsdom */

import { act, render } from "@testing-library/react"
import { useRef } from "react"
import { useShellColumnsStore } from "@/stores/ui/shell-columns-store"
import { useReportShellColumn } from "./use-report-shell-column"

const observers: Array<{ cb: ResizeObserverCallback; el: Element | null }> = []
let width = 0

beforeAll(() => {
  class RO {
    private cb: ResizeObserverCallback
    private entry = { cb: null as unknown as ResizeObserverCallback, el: null as Element | null }
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb
      this.entry = { cb, el: null }
      observers.push(this.entry)
    }
    observe(el: Element) {
      this.entry.el = el
    }
    disconnect() {
      this.entry.el = null
    }
    unobserve() {}
  }
  Object.defineProperty(globalThis, "ResizeObserver", { value: RO, configurable: true })
  jest
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(() => ({ width, height: 40 }) as DOMRect)
})

beforeEach(() => {
  observers.length = 0
  width = 0
  act(() => useShellColumnsStore.setState({ widths: { sidebar: 0, dock: 0 } }))
})

function Column({ column }: { column: "sidebar" | "dock" }) {
  const ref = useRef<HTMLDivElement | null>(null)
  useReportShellColumn(column, ref)
  return <div ref={ref} data-testid="col" />
}

describe("useReportShellColumn", () => {
  it("publishes the mounted width, follows resizes, and zeroes on unmount", () => {
    width = 296
    const { unmount } = render(<Column column="sidebar" />)
    expect(useShellColumnsStore.getState().widths.sidebar).toBe(296)

    width = 240
    act(() => {
      for (const o of observers) if (o.el) o.cb([], {} as ResizeObserver)
    })
    expect(useShellColumnsStore.getState().widths.sidebar).toBe(240)

    unmount()
    expect(useShellColumnsStore.getState().widths.sidebar).toBe(0)
  })

  it("keeps the two columns independent", () => {
    width = 400
    render(<Column column="dock" />)
    expect(useShellColumnsStore.getState().widths).toEqual({ sidebar: 0, dock: 400 })
  })
})
