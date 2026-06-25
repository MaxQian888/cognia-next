import { act, renderHook } from "@testing-library/react"
import type { Key } from "ink"

import { panelFooterHint, panelKeyAction, usePanelScroll } from "./usePanelScroll"

/** Build an Ink Key with every flag false, then override the named ones. Cast
 * because Ink's `Key` carries extra optional fields a test never needs to set. */
function key(over: Partial<Key> = {}): Key {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    ...over,
  } as Key
}

describe("panelKeyAction", () => {
  it("maps arrows to single-line scrolls", () => {
    expect(panelKeyAction("", key({ upArrow: true }))).toBe("lineUp")
    expect(panelKeyAction("", key({ downArrow: true }))).toBe("lineDown")
  })
  it("maps PgUp/PgDn and Space/b to page scrolls", () => {
    expect(panelKeyAction("", key({ pageUp: true }))).toBe("pageUp")
    expect(panelKeyAction("", key({ pageDown: true }))).toBe("pageDown")
    expect(panelKeyAction("b", key())).toBe("pageUp")
    expect(panelKeyAction(" ", key())).toBe("pageDown")
  })
  it("returns null for keys the panel handles itself", () => {
    expect(panelKeyAction("", key({ escape: true }))).toBeNull()
    expect(panelKeyAction("q", key())).toBeNull()
  })
})

describe("panelFooterHint", () => {
  it("shows just the close hint when nothing is hidden", () => {
    expect(panelFooterHint({ above: 0, below: 0 })).toBe("esc to close")
  })
  it("shows the hidden-rows indicator and scroll keys when content overflows", () => {
    expect(panelFooterHint({ above: 3, below: 7 })).toContain("↑ 3 ↓ 7")
    expect(panelFooterHint({ above: 3, below: 7 })).toContain("PgUp/PgDn")
  })
})

describe("usePanelScroll", () => {
  it("starts at the top with nothing hidden until measured", () => {
    const { result } = renderHook(() => usePanelScroll(20))
    expect(result.current.offset).toBe(0)
    expect(result.current.hidden).toEqual({ above: 0, below: 0 })
  })

  it("reports rows below once content overflows the viewport", () => {
    const { result } = renderHook(() => usePanelScroll(20))
    act(() => result.current.measure(50))
    expect(result.current.offset).toBe(0)
    expect(result.current.hidden).toEqual({ above: 0, below: 30 })
  })

  it("scrolls down a line and a page, consuming the key", () => {
    const { result } = renderHook(() => usePanelScroll(20))
    act(() => result.current.measure(50))
    let consumed = false
    act(() => {
      consumed = result.current.onKey("", key({ downArrow: true }))
    })
    expect(consumed).toBe(true)
    expect(result.current.offset).toBe(1)
    act(() => result.current.onKey("", key({ pageDown: true })))
    // page step = viewport-1 = 19, from 1 → 20, clamped to maxScroll 30.
    expect(result.current.offset).toBe(20)
    expect(result.current.hidden).toEqual({ above: 20, below: 10 })
  })

  it("does not scroll past the top, and reports the key unconsumed for close keys", () => {
    const { result } = renderHook(() => usePanelScroll(20))
    act(() => result.current.measure(50))
    act(() => result.current.onKey("", key({ upArrow: true })))
    expect(result.current.offset).toBe(0)
    let consumed = true
    act(() => {
      consumed = result.current.onKey("", key({ escape: true }))
    })
    expect(consumed).toBe(false)
  })

  it("ignores a measure that doesn't change the height (stable identity)", () => {
    const { result } = renderHook(() => usePanelScroll(20))
    act(() => result.current.measure(50))
    const before = result.current.measure
    act(() => result.current.measure(50))
    expect(result.current.measure).toBe(before)
  })
})
