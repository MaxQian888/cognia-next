import React from "react"
import { render } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"

import { SelectList } from "./SelectList"

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
