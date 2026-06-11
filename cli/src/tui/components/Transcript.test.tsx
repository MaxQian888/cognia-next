import React from "react"
import { render } from "@testing-library/react"

import { Transcript } from "./Transcript"
import type { Cell } from "../state/types"

describe("Transcript", () => {
  it("renders every cell in order", () => {
    const cells: Cell[] = [
      { id: "1", kind: "user", text: "question" },
      { id: "2", kind: "assistant", raw: "answer" },
    ]
    const { container } = render(<Transcript cells={cells} />)
    const text = container.textContent ?? ""
    expect(text).toContain("question")
    expect(text).toContain("answer")
  })

  it("renders nothing for an empty transcript", () => {
    const { container } = render(<Transcript cells={[]} />)
    expect(container.textContent).toBe("")
  })

  it("emits the header as the first row when provided", () => {
    const cells: Cell[] = [{ id: "1", kind: "user", text: "hello" }]
    const { container } = render(<Transcript cells={cells} header={<span>BANNER</span>} />)
    const text = container.textContent ?? ""
    expect(text).toContain("BANNER")
    expect(text).toContain("hello")
    expect(text.indexOf("BANNER")).toBeLessThan(text.indexOf("hello"))
  })

  it("renders the header even with an empty transcript", () => {
    const { container } = render(<Transcript cells={[]} header={<span>BANNER</span>} />)
    expect(container.textContent).toContain("BANNER")
  })
})
