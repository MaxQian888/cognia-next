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

  it("renders the token trend, composition bar and top tools when data is present", () => {
    const { container } = render(
      <UsagePanel
        usage={{ inputTokens: 1000, cacheReadInputTokens: 2000, outputTokens: 500 }}
        model="claude-x"
        usageHistory={[1000, 2000, 1500]}
        toolStats={{ read: { calls: 12, errors: 0 }, bash: { calls: 4, errors: 1 } }}
        onClose={() => {}}
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("Token trend")
    expect(text).toContain("/turn")
    expect(text).toContain("Composition")
    expect(text).toContain("reused")
    expect(text).toContain("Top tools")
    expect(text).toContain("read ×12")
    expect(text).toContain("bash ×4 (1✗)")
    // Each tool row carries a relative-frequency bar (filled blocks).
    expect(text).toContain("▰")
  })

  it("hides the trend, composition and top-tools sections when there is no data", () => {
    const { container } = render(<UsagePanel onClose={() => {}} />)
    const text = container.textContent ?? ""
    expect(text).not.toContain("Token trend")
    expect(text).not.toContain("Composition")
    expect(text).not.toContain("Top tools")
  })

  it("closes on Escape", () => {
    const onClose = jest.fn()
    render(<UsagePanel onClose={onClose} />)
    __fireInput("", { escape: true })
    expect(onClose).toHaveBeenCalled()
  })
})
