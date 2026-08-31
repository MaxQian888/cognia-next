/**
 * @jest-environment jsdom
 */
import { createRef } from "react"
import { fireEvent, render, screen, within } from "@testing-library/react"

jest.mock("motion/react", () => jest.requireActual("../../__mocks__/motion-react.js"))

import { SelectionListItem, SelectionListPanel } from "./selection-surface"

function renderPanel(
  overrides: Partial<React.ComponentProps<typeof SelectionListPanel>> = {},
  items = ["one", "two", "three"]
) {
  const props: React.ComponentProps<typeof SelectionListPanel> = {
    containerRef: createRef<HTMLElement>(),
    placement: "above",
    reduceMotion: false,
    role: "menu",
    label: "More",
    onClose: jest.fn(),
    children: items.map((item, index) => (
      <SelectionListItem
        key={item}
        role="menuitem"
        label={item}
        active={index === 0}
        onClick={jest.fn()}
      />
    )),
    ...overrides,
  }
  return { ...render(<SelectionListPanel {...props} />), props }
}

const rows = () => within(screen.getByRole("menu")).getAllByRole("menuitem")

describe("SelectionListPanel", () => {
  it("hands Rust its own hit rect, so a click inside is not a click away", () => {
    const containerRef = createRef<HTMLElement>()
    renderPanel({ containerRef })
    expect(containerRef.current).toBe(screen.getByRole("menu"))
  })

  it("lands focus on the row the caller nominated", () => {
    renderPanel({ focusIndex: 2 })
    expect(rows()[2]).toHaveFocus()
  })

  it("moves with the arrow keys and wraps at both ends", () => {
    renderPanel()
    const menu = screen.getByRole("menu")
    expect(rows()[0]).toHaveFocus()

    fireEvent.keyDown(menu, { key: "ArrowDown" })
    expect(rows()[1]).toHaveFocus()
    fireEvent.keyDown(menu, { key: "ArrowUp" })
    expect(rows()[0]).toHaveFocus()
    fireEvent.keyDown(menu, { key: "ArrowUp" })
    expect(rows()[2]).toHaveFocus()
    fireEvent.keyDown(menu, { key: "ArrowDown" })
    expect(rows()[0]).toHaveFocus()
  })

  it("jumps to the ends with Home and End", () => {
    renderPanel()
    const menu = screen.getByRole("menu")
    fireEvent.keyDown(menu, { key: "End" })
    expect(rows()[2]).toHaveFocus()
    fireEvent.keyDown(menu, { key: "Home" })
    expect(rows()[0]).toHaveFocus()
  })

  it("closes on Escape and leaves every other key to the browser", () => {
    const onClose = jest.fn()
    renderPanel({ onClose })
    const menu = screen.getByRole("menu")
    fireEvent.keyDown(menu, { key: "a" })
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(menu, { key: "Escape" })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("exposes exactly one tab stop, so Tab leaves the list", () => {
    renderPanel()
    expect(rows().filter((row) => row.getAttribute("tabindex") === "0")).toHaveLength(1)
  })

  /**
   * The native window is sized from a content signature assembled by the view,
   * and the view cannot see a submenu open inside this component. Without the
   * callback the second page is drawn into a window measured for the first and
   * cropped by `overflow: hidden`.
   */
  it("asks for a fresh measurement whenever it turns a page", () => {
    const onResize = jest.fn()
    const { rerender, props } = renderPanel({ onResize, pageKey: "root" })
    expect(onResize).toHaveBeenCalledTimes(1)

    rerender(<SelectionListPanel {...props} onResize={onResize} pageKey="cognia:rewrite" />)
    expect(onResize).toHaveBeenCalledTimes(2)
  })

  /**
   * `[data-surface-layer]` in globals.css is unlayered and Tailwind's
   * arbitrary-property utilities are not, so the tint cannot be a class here.
   * It has to reach the element as an inline custom property or the tier paints
   * the overlay opaque over the user's desktop.
   */
  it("declares the tier and carries its glass tint inline", () => {
    renderPanel()
    const menu = screen.getByRole("menu")
    expect(menu).toHaveAttribute("data-surface-layer", "overlay")
    expect(menu.style.getPropertyValue("--surface-bg")).toContain("color-mix")
  })
})

describe("SelectionListItem", () => {
  it("marks the chosen option for assistive tech", () => {
    render(<SelectionListItem role="option" label="Japanese" selected active onClick={jest.fn()} />)
    const option = screen.getByRole("option", { name: "Japanese" })
    expect(option).toHaveAttribute("aria-selected", "true")
    expect(option).toHaveAttribute("tabindex", "0")
  })

  it("leaves aria-selected off a command row, where it would be meaningless", () => {
    render(<SelectionListItem role="menuitem" label="Rewrite" onClick={jest.fn()} />)
    expect(screen.getByRole("menuitem", { name: "Rewrite" })).not.toHaveAttribute("aria-selected")
  })

  it("fires once per click", () => {
    const onClick = jest.fn()
    render(<SelectionListItem role="menuitem" label="Rewrite" onClick={onClick} />)
    fireEvent.click(screen.getByRole("menuitem", { name: "Rewrite" }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})
