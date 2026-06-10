import React from "react"
import { render } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"

import { UsagePanel } from "./UsagePanel"

describe("UsagePanel", () => {
  beforeEach(() => __resetInk())

  it("renders the usage rows", () => {
    const { container } = render(
      <UsagePanel
        usage={{ inputTokens: 1200, outputTokens: 300, totalCostUsd: 0.05 }}
        model="claude-x"
        onClose={() => {}}
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("Usage")
    expect(text).toContain("Input")
    expect(text).toContain("1.2k")
  })

  it("closes on Escape", () => {
    const onClose = jest.fn()
    render(<UsagePanel onClose={onClose} />)
    __fireInput("", { escape: true })
    expect(onClose).toHaveBeenCalled()
  })
})
