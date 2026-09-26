/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen } from "@testing-library/react"
import { useEffect, useRef, useState } from "react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { SidebarRow } from "./sidebar-nav-section"
import { SidebarRovingGroup, SidebarRowsScope } from "./sidebar-row-roving"

/** Three rows in one scope; `activeId` claims the tab stop. */
function Rows({ activeId }: { activeId?: string }) {
  return (
    <>
      <SidebarRow icon={null} label="Canvas" testId="row-a" active={activeId === "row-a"} />
      <SidebarRow icon={null} label="Inbox" testId="row-b" active={activeId === "row-b"} />
      <SidebarRow icon={null} label="Settings" testId="row-c" active={activeId === "row-c"} />
    </>
  )
}

const rows = () => ["row-a", "row-b", "row-c"].map((id) => screen.getByTestId(id))
const tabStops = () => rows().filter((row) => row.tabIndex === 0)

describe("SidebarRowsScope", () => {
  it("gives the whole stack one tab stop, held by the active row", () => {
    render(
      <SidebarRowsScope>
        <Rows activeId="row-b" />
      </SidebarRowsScope>
    )
    expect(tabStops()).toEqual([screen.getByTestId("row-b")])
    expect(screen.getByTestId("row-a").tabIndex).toBe(-1)
    expect(screen.getByTestId("row-c").tabIndex).toBe(-1)
  })

  it("falls back to the first row when nothing is active, so Tab always reaches the sidebar", () => {
    render(
      <SidebarRowsScope>
        <Rows />
      </SidebarRowsScope>
    )
    expect(tabStops()).toEqual([screen.getByTestId("row-a")])
  })

  it("moves focus with the arrow keys and carries the tab stop along", () => {
    render(
      <SidebarRowsScope>
        <Rows activeId="row-a" />
      </SidebarRowsScope>
    )
    const [a, b, c] = rows()
    a.focus()
    fireEvent.keyDown(a, { key: "ArrowDown" })
    expect(b).toHaveFocus()
    expect(tabStops()).toEqual([b])
    fireEvent.keyDown(b, { key: "ArrowDown" })
    expect(c).toHaveFocus()
    fireEvent.keyDown(c, { key: "ArrowUp" })
    expect(b).toHaveFocus()
  })

  it("jumps to the ends with Home / End and does not wrap past them", () => {
    render(
      <SidebarRowsScope>
        <Rows activeId="row-b" />
      </SidebarRowsScope>
    )
    const [a, b, c] = rows()
    b.focus()
    fireEvent.keyDown(b, { key: "End" })
    expect(c).toHaveFocus()
    // At the bottom edge ArrowDown stays put rather than wrapping to the top.
    fireEvent.keyDown(c, { key: "ArrowDown" })
    expect(c).toHaveFocus()
    fireEvent.keyDown(c, { key: "Home" })
    expect(a).toHaveFocus()
    fireEvent.keyDown(a, { key: "ArrowUp" })
    expect(a).toHaveFocus()
  })

  it("stops the arrow key from reaching a list handler below", () => {
    const outerKeyDown = jest.fn()
    render(
      <div onKeyDown={outerKeyDown}>
        <SidebarRowsScope>
          <Rows activeId="row-a" />
        </SidebarRowsScope>
      </div>
    )
    const [a] = rows()
    a.focus()
    fireEvent.keyDown(a, { key: "ArrowDown" })
    expect(outerKeyDown).not.toHaveBeenCalled()
    // A key the sidebar does not own still bubbles — `/` focuses the search.
    fireEvent.keyDown(screen.getByTestId("row-b"), { key: "/" })
    expect(outerKeyDown).toHaveBeenCalled()
  })

  it("hands the tab stop to whichever row takes focus another way", () => {
    render(
      <SidebarRowsScope>
        <Rows activeId="row-a" />
      </SidebarRowsScope>
    )
    fireEvent.focus(screen.getByTestId("row-c"))
    expect(tabStops()).toEqual([screen.getByTestId("row-c")])
  })

  it("adopts a caller's container instead of adding a wrapper element", () => {
    function WithContainer() {
      const ref = useRef<HTMLDivElement | null>(null)
      return (
        <div ref={ref} data-testid="own-container">
          <SidebarRowsScope containerRef={ref}>
            <Rows activeId="row-a" />
          </SidebarRowsScope>
        </div>
      )
    }
    render(<WithContainer />)
    const container = screen.getByTestId("own-container")
    // No scope div of its own: the rows are direct children of the caller's.
    expect(container.querySelector("[data-sidebar-rows-scope]")).toBeNull()
    const [a, b] = rows()
    a.focus()
    fireEvent.keyDown(a, { key: "ArrowDown" })
    expect(b).toHaveFocus()
  })

  it("leaves rows outside a scope exactly as they were", () => {
    const outerKeyDown = jest.fn()
    render(
      <div onKeyDown={outerKeyDown}>
        <Rows activeId="row-a" />
      </div>
    )
    const [a] = rows()
    // No roving attribute, no forced tabIndex — the icon column and the mobile
    // Sheet keep plain buttons.
    expect(a).not.toHaveAttribute("data-sidebar-row")
    expect(a.tabIndex).toBe(0)
    fireEvent.keyDown(a, { key: "ArrowDown" })
    expect(outerKeyDown).toHaveBeenCalled()
  })
})

/** A foreign control: a button that knows nothing about the roving. */
function Foreign({ id, onKeyDown }: { id: string; onKeyDown?: (key: string) => void }) {
  return (
    <button type="button" data-testid={id} onKeyDown={(event) => onKeyDown?.(event.key)}>
      {id}
    </button>
  )
}

/**
 * A control that changes on its own schedule, the way a status segment does
 * when its store flips: driven from outside through an event, so only it
 * re-renders — never the group around it.
 */
const lateControl = new EventTarget()
const driveLate = (patch: { visible?: boolean; disabled?: boolean }) =>
  lateControl.dispatchEvent(new CustomEvent("patch", { detail: patch }))

function Late({ initiallyVisible }: { initiallyVisible: boolean }) {
  const [state, setState] = useState({ visible: initiallyVisible, disabled: false })
  useEffect(() => {
    const onPatch = (event: Event) =>
      setState((current) => ({ ...current, ...(event as CustomEvent).detail }))
    lateControl.addEventListener("patch", onPatch)
    return () => lateControl.removeEventListener("patch", onPatch)
  }, [])
  return state.visible ? (
    <button type="button" data-testid="late" disabled={state.disabled}>
      late
    </button>
  ) : null
}

describe("SidebarRovingGroup", () => {
  it("enrols the controls it wraps as rows, without a tab stop of their own", () => {
    render(
      <SidebarRowsScope>
        <SidebarRow icon={null} label="Canvas" testId="row-a" active />
        <SidebarRovingGroup groupKey="status" className="contents">
          <Foreign id="seg-1" />
          <span>
            <Foreign id="seg-2" />
          </span>
        </SidebarRovingGroup>
        <SidebarRow icon={null} label="Settings" testId="row-c" />
      </SidebarRowsScope>
    )
    expect(screen.getByTestId("seg-1")).toHaveAttribute("data-sidebar-row", "status:seg-1")
    expect(screen.getByTestId("seg-2")).toHaveAttribute("data-sidebar-row", "status:seg-2")
    expect(screen.getByTestId("seg-1").tabIndex).toBe(-1)
    expect(screen.getByTestId("seg-2").tabIndex).toBe(-1)
    expect(screen.getByTestId("row-a").tabIndex).toBe(0)
  })

  it("walks into, through and out of the group with the arrows, ahead of the control's own handler", () => {
    const ownKeyDown = jest.fn()
    render(
      <SidebarRowsScope>
        <SidebarRow icon={null} label="Canvas" testId="row-a" active />
        <SidebarRovingGroup groupKey="status">
          <Foreign id="seg-1" onKeyDown={ownKeyDown} />
          <Foreign id="seg-2" onKeyDown={ownKeyDown} />
        </SidebarRovingGroup>
        <SidebarRow icon={null} label="Settings" testId="row-c" />
      </SidebarRowsScope>
    )
    const a = screen.getByTestId("row-a")
    const seg1 = screen.getByTestId("seg-1")
    const seg2 = screen.getByTestId("seg-2")
    a.focus()
    fireEvent.keyDown(a, { key: "ArrowDown" })
    expect(seg1).toHaveFocus()
    // The tab stop travels with focus into the group.
    expect(seg1.tabIndex).toBe(0)
    expect(a.tabIndex).toBe(-1)
    fireEvent.keyDown(seg1, { key: "ArrowDown" })
    expect(seg2).toHaveFocus()
    fireEvent.keyDown(seg2, { key: "ArrowDown" })
    expect(screen.getByTestId("row-c")).toHaveFocus()
    fireEvent.keyDown(screen.getByTestId("row-c"), { key: "ArrowUp" })
    expect(seg2).toHaveFocus()
    fireEvent.keyDown(seg2, { key: "Home" })
    expect(a).toHaveFocus()
    // Arrow keys never reached the controls; everything else still does.
    expect(ownKeyDown).not.toHaveBeenCalled()
    fireEvent.keyDown(seg1, { key: "Enter" })
    expect(ownKeyDown).toHaveBeenCalledWith("Enter")
  })

  it("takes the tab stop when focus arrives by other means", () => {
    render(
      <SidebarRowsScope>
        <SidebarRow icon={null} label="Canvas" testId="row-a" active />
        <SidebarRovingGroup groupKey="status">
          <Foreign id="seg-1" />
        </SidebarRovingGroup>
      </SidebarRowsScope>
    )
    act(() => screen.getByTestId("seg-1").focus())
    expect(screen.getByTestId("seg-1").tabIndex).toBe(0)
    expect(screen.getByTestId("row-a").tabIndex).toBe(-1)
  })

  it("enrols a control that mounts later, and drops one that becomes disabled", async () => {
    render(
      <SidebarRowsScope>
        <SidebarRow icon={null} label="Canvas" testId="row-a" active />
        <SidebarRovingGroup groupKey="status">
          <Late initiallyVisible={false} />
        </SidebarRovingGroup>
      </SidebarRowsScope>
    )
    // Only `Late` re-renders — the group learns of the button from the DOM.
    await act(async () => driveLate({ visible: true }))
    expect(screen.getByTestId("late")).toHaveAttribute("data-sidebar-row", "status:late")
    expect(screen.getByTestId("late").tabIndex).toBe(-1)
    await act(async () => driveLate({ disabled: true }))
    expect(screen.getByTestId("late")).not.toHaveAttribute("data-sidebar-row")
  })

  it("hands the tab stop on when the control holding it unmounts", async () => {
    render(
      <SidebarRowsScope>
        <SidebarRovingGroup groupKey="status">
          <Late initiallyVisible />
        </SidebarRovingGroup>
        <SidebarRow icon={null} label="Settings" testId="row-c" />
      </SidebarRowsScope>
    )
    // Nothing is active, so the first row — the enrolled control — holds it.
    expect(screen.getByTestId("late").tabIndex).toBe(0)
    await act(async () => driveLate({ visible: false }))
    expect(screen.getByTestId("row-c").tabIndex).toBe(0)
  })

  it("changes nothing outside a scope", () => {
    render(
      <SidebarRovingGroup groupKey="status">
        <Foreign id="seg-1" />
      </SidebarRovingGroup>
    )
    const seg = screen.getByTestId("seg-1")
    expect(seg).not.toHaveAttribute("data-sidebar-row")
    expect(seg).not.toHaveAttribute("tabindex")
  })
})
