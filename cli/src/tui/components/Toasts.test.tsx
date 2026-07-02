import React from "react"
import { render } from "@testing-library/react"

import { Toasts } from "./Toasts"
import type { Toast } from "../state/types"

describe("Toasts", () => {
  it("renders nothing when there are no toasts", () => {
    const { container } = render(<Toasts toasts={[]} />)
    expect(container.textContent).toBe("")
  })

  it("renders each toast with a severity glyph", () => {
    const toasts: Toast[] = [
      { id: "1", severity: "info", message: "info msg" },
      { id: "2", severity: "warn", message: "warn msg" },
      { id: "3", severity: "error", message: "error msg" },
    ]
    const { container } = render(<Toasts toasts={toasts} />)
    const text = container.textContent ?? ""
    expect(text).toContain("ℹ info msg")
    expect(text).toContain("⚠ warn msg")
    expect(text).toContain("✗ error msg")
  })

  it("renders a hint line under a toast that has one", () => {
    const { container } = render(
      <Toasts toasts={[{ id: "1", severity: "error", message: "boom", hint: "do the fix" }]} />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("boom")
    expect(text).toContain("do the fix")
  })
})
