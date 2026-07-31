/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import type { UsageInfo } from "@/lib/claude/adapter"
import { UsageBreakdown } from "./usage-breakdown"

describe("UsageBreakdown", () => {
  it("always shows input + output token lines", () => {
    render(<UsageBreakdown usage={{ inputTokens: 12, outputTokens: 34 } as UsageInfo} />)
    expect(screen.getByText(/12/)).toBeInTheDocument()
    expect(screen.getByText(/34/)).toBeInTheDocument()
  })

  it("shows reasoning / cache / cost lines only when present and non-zero", () => {
    const { container, rerender } = render(
      <UsageBreakdown
        usage={{ inputTokens: 1, outputTokens: 1, reasoningTokens: 0 } as UsageInfo}
      />
    )
    // reasoning=0 → no extra line beyond input+output (two line-divs)
    expect(container.querySelector(".font-mono")!.children).toHaveLength(2)

    rerender(
      <UsageBreakdown
        usage={
          {
            inputTokens: 1,
            outputTokens: 1,
            reasoningTokens: 5,
            cacheReadInputTokens: 7,
            cacheCreationInputTokens: 9,
            totalCostUsd: 0.1234,
          } as UsageInfo
        }
      />
    )
    expect(screen.getByText(/5/)).toBeInTheDocument()
    expect(screen.getByText(/7/)).toBeInTheDocument()
    expect(screen.getByText(/9/)).toBeInTheDocument()
    expect(screen.getByText(/0\.1234/)).toBeInTheDocument()
  })
})
