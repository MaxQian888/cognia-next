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
})
