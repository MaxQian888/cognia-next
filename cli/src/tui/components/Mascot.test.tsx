import React from "react"
import { render } from "@testing-library/react"

import { Mascot } from "./Mascot"
import { mascotView } from "../mascot/mascot"

describe("Mascot", () => {
  it("renders nothing when disabled", () => {
    const { container } = render(<Mascot mood="working" style="clawd" enabled={false} />)
    expect(container.textContent ?? "").toBe("")
  })

  it("renders the idle creature (static, no word besides zzz)", () => {
    const { container } = render(<Mascot mood="idle" style="clawd" enabled />)
    const text = container.textContent ?? ""
    expect(text).toContain(mascotView("clawd", "idle", 0).creature)
    expect(text).toContain("zzz")
  })

  it("renders the working creature + a gerund word", () => {
    const { container } = render(<Mascot mood="working" style="clawd" enabled />)
    const text = container.textContent ?? ""
    expect(text).toContain(mascotView("clawd", "working", 0).creature)
    expect(text).toContain("working")
  })

  it("honors the chosen style", () => {
    const { container } = render(<Mascot mood="idle" style="robot" enabled />)
    expect(container.textContent ?? "").toContain(mascotView("robot", "idle", 0).creature)
  })
})
