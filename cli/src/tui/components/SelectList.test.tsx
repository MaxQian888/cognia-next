import React from "react"
import { render } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"

import { SelectList } from "./SelectList"

// jsdom has no Yoga layout, so stub the absolute-position reader for click tests.
jest.mock("../input/element-position", () => ({
  absoluteTopLeft: () => ({ top: 0, left: 0 }),
}))

const items = [{ label: "One", hint: "first" }, { label: "Two" }, { label: "Three" }]

describe("SelectList", () => {
  beforeEach(() => __resetInk())

  it("renders items with the highlighted row and hints", () => {
    const { container } = render(
      <SelectList title="Pick" items={items} index={1} onMove={() => {}} onSelect={() => {}} />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("Pick")
    expect(text).toContain("One")
    expect(text).toContain("first")
    expect(text).toContain("❯ Two")
  })

  it("moves on arrow keys and selects on Enter", () => {
    const onMove = jest.fn()
    const onSelect = jest.fn()
    render(<SelectList items={items} index={0} onMove={onMove} onSelect={onSelect} />)
    __fireInput("", { downArrow: true })
    __fireInput("", { upArrow: true })
    __fireInput("", { return: true })
    expect(onMove).toHaveBeenNthCalledWith(1, 1)
    expect(onMove).toHaveBeenNthCalledWith(2, -1)
    expect(onSelect).toHaveBeenCalledWith(0)
  })

  it("cancels on Escape", () => {
    const onCancel = jest.fn()
    render(
      <SelectList
        items={items}
        index={0}
        onMove={() => {}}
        onSelect={() => {}}
        onCancel={onCancel}
      />
    )
    __fireInput("", { escape: true })
    expect(onCancel).toHaveBeenCalled()
  })

  it("does nothing on Escape without an onCancel handler", () => {
    render(<SelectList items={items} index={0} onMove={() => {}} onSelect={() => {}} />)
    expect(() => __fireInput("", { escape: true })).not.toThrow()
  })

  it("shows the default key-hint footer, and hides it when footerHint is false", () => {
    const withFooter = render(
      <SelectList items={items} index={0} onMove={() => {}} onSelect={() => {}} />
    )
    expect(withFooter.container.textContent ?? "").toContain("Enter select")
    __resetInk()
    const without = render(
      <SelectList
        items={items}
        index={0}
        onMove={() => {}}
        onSelect={() => {}}
        footerHint={false}
      />
    )
    expect(without.container.textContent ?? "").not.toContain("Enter select")
  })

  it("selects the clicked row (highlight + select) in scroll mouse mode", () => {
    const onMove = jest.fn()
    const onSelect = jest.fn()
    // No title → headerRows 0; border 1 → first item at 0-based row 1 (SGR row 2).
    render(<SelectList items={items} index={0} onMove={onMove} onSelect={onSelect} />)
    __fireInput("[<0;3;3M", {}) // SGR row 3 → 0-based 2 → item offset 1 (Two)
    expect(onSelect).toHaveBeenCalledWith(1)
    expect(onMove).toHaveBeenCalledWith(1) // move highlight from index 0 to 1
  })

  it("moves the highlight on the mouse wheel", () => {
    const onMove = jest.fn()
    render(<SelectList items={items} index={1} onMove={onMove} onSelect={() => {}} />)
    __fireInput("[<64;1;1M", {}) // wheel up
    __fireInput("[<65;1;1M", {}) // wheel down
    expect(onMove).toHaveBeenNthCalledWith(1, -1)
    expect(onMove).toHaveBeenNthCalledWith(2, 1)
  })

  it("ignores a click on the border/title without selecting", () => {
    const onSelect = jest.fn()
    render(
      <SelectList title="Pick" items={items} index={0} onMove={() => {}} onSelect={onSelect} />
    )
    __fireInput("[<0;1;1M", {}) // SGR row 1 → 0-based 0 = the top border
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("windows a long list around the selection with scroll hints", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ label: `Item ${i}` }))
    const { container } = render(
      <SelectList items={many} index={20} maxRows={5} onMove={() => {}} onSelect={() => {}} />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("❯ Item 20") // selection visible
    expect(text).toContain("↑") // hidden rows above
    expect(text).toContain("↓") // hidden rows below
    expect(text).not.toContain("Item 0") // scrolled out of view
  })
})
