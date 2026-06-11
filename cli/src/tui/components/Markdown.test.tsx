import React from "react"
import { render } from "@testing-library/react"

import { Markdown } from "./Markdown"

describe("Markdown", () => {
  it("renders headings, emphasis, code spans and links", () => {
    const { container } = render(<Markdown raw={"# Title\n\na **b** `c` [d](http://x) ~~e~~"} />)
    const text = container.textContent ?? ""
    expect(text).toContain("Title")
    expect(text).toContain("b")
    expect(text).toContain("c")
    expect(text).toContain("d")
    expect(text).toContain("e")
  })

  it("renders inline content (code + bold) inside a level-3 heading", () => {
    const { container } = render(<Markdown raw={"### Status `ok` and **done**"} />)
    const text = container.textContent ?? ""
    expect(text).toContain("Status")
    expect(text).toContain("ok")
    expect(text).toContain("done")
  })

  it("renders fenced code, blockquotes, lists and rules", () => {
    const { container } = render(
      <Markdown raw={"```ts\nconst x = 1\n```\n\n> quote\n\n- item\n\n---"} />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("const x = 1")
    expect(text).toContain("quote")
    expect(text).toContain("item")
  })

  it("renders an empty document without crashing", () => {
    const { container } = render(<Markdown raw="" />)
    expect(container.textContent).toBe("")
  })

  it("renders a GFM table with its header and cell values", () => {
    const src = ["| Name | Age |", "| --- | --- |", "| Ann | 30 |", "| Bob | 25 |"].join("\n")
    const { container } = render(<Markdown raw={src} />)
    const text = container.textContent ?? ""
    expect(text).toContain("Name")
    expect(text).toContain("Age")
    expect(text).toContain("Ann")
    expect(text).toContain("30")
    expect(text).toContain("Bob")
    // Column separator + header rule are drawn.
    expect(text).toContain("│")
    expect(text).toContain("─")
  })

  it("pads center- and right-aligned table columns", () => {
    const src = [
      "| L | C | R |",
      "| :-- | :-: | --: |",
      "| a | bb | ccc |",
      "| aaaa | b | c |",
    ].join("\n")
    const { container } = render(<Markdown raw={src} />)
    const text = container.textContent ?? ""
    expect(text).toContain("a")
    expect(text).toContain("bb")
    expect(text).toContain("ccc")
    // The short right-aligned cell "c" gets leading padding to the column width.
    expect(text).toContain("  c")
  })
})
