/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"
import { useRef } from "react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { SidebarRow } from "./sidebar-nav-section"
import { SidebarRowsScope } from "./sidebar-row-roving"

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
