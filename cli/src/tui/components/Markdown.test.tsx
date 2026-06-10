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
})
