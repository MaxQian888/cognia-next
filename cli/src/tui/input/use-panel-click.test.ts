import type { DOMElement } from "ink"

import { usePanelClick } from "./use-panel-click"

/** A click SGR report for a left-button press at 1-based (col,row). */
const click = (col: number, row: number) => `[<0;${col};${row}M`
/** A wheel-up / wheel-down SGR report. */
const wheelUp = "[<64;1;1M"
const wheelDown = "[<65;1;1M"

const boxRef = { current: {} as DOMElement }

describe("usePanelClick", () => {
  it("routes wheel events to onWheel and swallows them", () => {
    const onWheel = jest.fn()
    const onPick = jest.fn()
    const handle = usePanelClick({
      boxRef,
      headerRows: 1,
      hasAboveMore: false,
      visibleCount: 3,
      onPick,
      onWheel,
      resolvePos: () => ({ top: 0, left: 0 }),
    })
    expect(handle(wheelUp)).toBe(true)
    expect(handle(wheelDown)).toBe(true)
    expect(onWheel.mock.calls).toEqual([["up"], ["down"]])
    expect(onPick).not.toHaveBeenCalled()
  })

  it("maps a click to the item offset within the visible window", () => {
    const onPick = jest.fn()
    const handle = usePanelClick({
      boxRef,
      headerRows: 1,
      hasAboveMore: false,
      visibleCount: 5,
      // panelTop=8, border=1, header=1 → first item row is 10 (0-based).
      resolvePos: () => ({ top: 8, left: 2 }),
      onPick,
    })
    // SGR row is 1-based; clicking 1-based row 15 → 0-based 14 → offset 4.
    expect(handle(click(30, 15))).toBe(true)
    expect(onPick).toHaveBeenCalledWith(4)
  })

  it("accounts for the '↑ N more' indicator row", () => {
    const onPick = jest.fn()
    const handle = usePanelClick({
      boxRef,
      headerRows: 1,
      hasAboveMore: true,
      visibleCount: 5,
      resolvePos: () => ({ top: 0, left: 0 }),
      onPick,
    })
    // border(1)+header(1)+aboveMore(1) → first item at 0-based row 3 → SGR row 4.
    expect(handle(click(1, 4))).toBe(true)
    expect(onPick).toHaveBeenCalledWith(0)
  })

  it("swallows a click on the border/header without picking", () => {
    const onPick = jest.fn()
    const handle = usePanelClick({
      boxRef,
      headerRows: 1,
      hasAboveMore: false,
      visibleCount: 3,
      resolvePos: () => ({ top: 8, left: 0 }),
      onPick,
    })
    // 1-based row 9 → 0-based 8 = the border row; first item is 0-based 10.
    expect(handle(click(5, 9))).toBe(true)
    expect(onPick).not.toHaveBeenCalled()
  })

  it("swallows a click when the layout is not resolvable (jsdom default)", () => {
    const onPick = jest.fn()
    const handle = usePanelClick({
      boxRef,
      headerRows: 0,
      hasAboveMore: false,
      visibleCount: 3,
      resolvePos: () => null,
      onPick,
    })
    expect(handle(click(1, 1))).toBe(true)
    expect(onPick).not.toHaveBeenCalled()
  })

  it("defaults resolvePos to absoluteTopLeft (no Yoga in tests → null → no pick)", () => {
    const onPick = jest.fn()
    const handle = usePanelClick({
      boxRef: { current: null },
      headerRows: 0,
      hasAboveMore: false,
      visibleCount: 3,
      onPick,
    })
    expect(handle(click(1, 1))).toBe(true)
    expect(onPick).not.toHaveBeenCalled()
  })

  it("returns false for non-mouse input so the host handles keys", () => {
    const handle = usePanelClick({
      boxRef,
      headerRows: 0,
      hasAboveMore: false,
      visibleCount: 3,
      resolvePos: () => ({ top: 0, left: 0 }),
      onPick: jest.fn(),
    })
    expect(handle("x")).toBe(false)
    expect(handle("")).toBe(false)
  })

  it("swallows drag/release ('other') reports without picking", () => {
    const onPick = jest.fn()
    const handle = usePanelClick({
      boxRef,
      headerRows: 0,
      hasAboveMore: false,
      visibleCount: 3,
      resolvePos: () => ({ top: 0, left: 0 }),
      onPick,
    })
    // Button release (suffix `m`) is an "other" event.
    expect(handle("[<0;1;1m")).toBe(true)
    expect(onPick).not.toHaveBeenCalled()
  })
})
