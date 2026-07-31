import React from "react"
import { act, render } from "@testing-library/react"
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

  it("renders the per-model breakdown once two+ models have run", () => {
    const { container } = render(
      <UsagePanel
        usage={{ inputTokens: 1000, outputTokens: 500 }}
        model="claude-opus-4-8"
        modelTotals={{
          "claude-opus-4-8": {
            costUsd: 51.18,
            inputTokens: 95_200,
            outputTokens: 271_300,
            cacheReadTokens: 64_800_000,
            cacheCreationTokens: 1_200_000,
            durationMs: 0,
          },
          "claude-haiku-4-5": {
            costUsd: 0.55,
            inputTokens: 2100,
            outputTokens: 16_400,
            cacheReadTokens: 2_900_000,
            cacheCreationTokens: 141_400,
            durationMs: 0,
          },
        }}
        onClose={() => {}}
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("Usage by model")
    expect(text).toContain("claude-opus-4-8")
    expect(text).toContain("claude-haiku-4-5")
    expect(text).toContain("64.8M cache r")
    expect(text).toContain("$51.18")
  })

  it("hides the per-model breakdown when only one model has run", () => {
    const { container } = render(
      <UsagePanel
        model="claude-opus-4-8"
        modelTotals={{
          "claude-opus-4-8": {
            costUsd: 1,
            inputTokens: 1000,
            outputTokens: 500,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            durationMs: 0,
          },
        }}
        onClose={() => {}}
      />
    )
    expect(container.textContent).not.toContain("Usage by model")
  })

  it("renders the cost trend when priced turns are present", () => {
    const { container } = render(
      <UsagePanel
        usage={{ inputTokens: 1000, outputTokens: 500 }}
        model="claude-x"
        costHistory={[0.01, 0.025, 0.018]}
        onClose={() => {}}
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("Cost trend")
  })

  it("hides the cost trend when every turn priced to zero", () => {
    const { container } = render(<UsagePanel costHistory={[0, 0, 0]} onClose={() => {}} />)
    expect(container.textContent).not.toContain("Cost trend")
  })

  it("hides the trend, composition and top-tools sections when there is no data", () => {
    const { container } = render(<UsagePanel onClose={() => {}} />)
    const text = container.textContent ?? ""
    expect(text).not.toContain("Token trend")
    expect(text).not.toContain("Cost trend")
    expect(text).not.toContain("Composition")
    expect(text).not.toContain("Top tools")
  })

  it("closes on Escape", () => {
    const onClose = jest.fn()
    render(<UsagePanel onClose={onClose} />)
    __fireInput("", { escape: true })
    expect(onClose).toHaveBeenCalled()
  })

  it("routes a scroll key to the viewport instead of closing", () => {
    const onClose = jest.fn()
    render(<UsagePanel onClose={onClose} viewportRows={4} />)
    act(() => __fireInput("", { pageDown: true }))
    act(() => __fireInput("", { downArrow: true }))
    expect(onClose).not.toHaveBeenCalled()
  })
})
