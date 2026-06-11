import React from "react"
import { render } from "@testing-library/react"

import { Inflight } from "./Inflight"

describe("Inflight", () => {
  it("collapses reasoning by default — indicator + expand hint, no body", () => {
    const { container } = render(
      <Inflight inflight={{ thinking: "pondering", text: "**answer**" }} />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("✻ Thinking…")
    expect(text).toContain("ctrl+o to expand")
    // The reasoning body stays hidden until detail mode.
    expect(text).not.toContain("pondering")
    expect(text).toContain("answer")
  })

  it("shows the full reasoning stream in verbose mode", () => {
    const { container } = render(
      <Inflight inflight={{ thinking: "pondering", text: "" }} verbose />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("✻ Thinking…")
    expect(text).toContain("pondering")
    // No expand hint when already expanded.
    expect(text).not.toContain("ctrl+o")
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
