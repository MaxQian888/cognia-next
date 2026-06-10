import React from "react"
import { render } from "@testing-library/react"

import { Inflight } from "./Inflight"

describe("Inflight", () => {
  it("renders streaming reasoning and text", () => {
    const { container } = render(
      <Inflight inflight={{ thinking: "pondering", text: "**answer**" }} />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("pondering")
    expect(text).toContain("answer")
  })

  it("renders only text when there is no reasoning", () => {
    const { container } = render(<Inflight inflight={{ thinking: "", text: "hi" }} />)
    expect(container.textContent).toContain("hi")
  })

  it("renders nothing when idle", () => {
    const { container } = render(<Inflight inflight={{ thinking: "", text: "" }} />)
    expect(container.textContent).toBe("")
  })
})
