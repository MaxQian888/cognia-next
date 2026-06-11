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

  it("aligns a table column whose cells contain CJK text", () => {
    // "模型" is 4 display columns; the ASCII header "Model" is 5. The narrower
    // CJK cell must be right-padded by the wide-aware width so the next column
    // still lines up — assert the separator follows the padded cell.
    const src = ["| Model | Note |", "| --- | --- |", "| 模型 | ok |"].join("\n")
    const { container } = render(<Markdown raw={src} />)
    const text = container.textContent ?? ""
    expect(text).toContain("模型")
    // The 4-wide cell is padded by 1 to the 5-wide "Model" column, then the
    // " │ " separator — so 2 spaces total. Without CJK-aware width it would be
    // padded by 3 (treating "模型" as 2 chars), leaving a ragged column.
    expect(text).toContain("模型  │")
    expect(text).not.toContain("模型   │")
  })

  it("renders GFM task-list checkboxes", () => {
    const { container } = render(<Markdown raw={"- [x] shipped\n- [ ] pending"} />)
    const text = container.textContent ?? ""
    expect(text).toContain("☑")
    expect(text).toContain("shipped")
    expect(text).toContain("☐")
    expect(text).toContain("pending")
  })
})
