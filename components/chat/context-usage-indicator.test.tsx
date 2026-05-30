/**
 * @jest-environment jsdom
 */
import React from "react"
import { act, render, screen } from "@testing-library/react"
import type { UIMessage } from "ai"
import { ContextUsageIndicator, ContextWindowHeader, UsageRow } from "./context-usage-indicator"
import { useChatStore } from "@/stores/chat"

// Echo translation keys (with params appended) so assertions stay stable.
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

const assistantWithUsage = (id: string, usage: Record<string, number>): UIMessage =>
  ({
    id,
    role: "assistant",
    parts: [{ type: "text", text: "hi" }],
    metadata: { usage },
  }) as unknown as UIMessage

describe("ContextUsageIndicator", () => {
  beforeEach(() => {
    useChatStore.getState().clear()
  })

  it("always renders (0 used) for a fresh session with no usage", () => {
    render(<ContextUsageIndicator modelId="claude-sonnet-4-6" />)
    const node = screen.getByTestId("context-usage-indicator")
    expect(node).toHaveAttribute("data-used-tokens", "0")
    // Sonnet 4.6 is the 1M tier.
    expect(node).toHaveAttribute("data-max-tokens", "1000000")
  })

  it("sums the latest turn incl. cacheCreation against the model window", () => {
    act(() => {
      useChatStore.getState().replaceMessages([
        assistantWithUsage("a-1", { inputTokens: 100, outputTokens: 50 }),
        assistantWithUsage("a-2", {
          inputTokens: 200,
          outputTokens: 100,
          cacheReadInputTokens: 20,
          cacheCreationInputTokens: 30,
        }),
      ])
    })
    render(<ContextUsageIndicator modelId="claude-sonnet-4-6" />)
    const node = screen.getByTestId("context-usage-indicator")
    // 200 + 100 + 20 + 30 = 350
    expect(node).toHaveAttribute("data-used-tokens", "350")
    expect(node).toHaveAttribute("data-max-tokens", "1000000")
  })

  it("respects an explicit maxTokens override", () => {
    act(() => {
      useChatStore
        .getState()
        .replaceMessages([assistantWithUsage("a-1", { inputTokens: 10, outputTokens: 5 })])
    })
    render(<ContextUsageIndicator modelId="claude-sonnet-4-6" maxTokens={4096} />)
    const node = screen.getByTestId("context-usage-indicator")
    expect(node).toHaveAttribute("data-max-tokens", "4096")
    expect(node).toHaveAttribute("data-used-tokens", "15")
  })

  it("tints the trigger red when over the auto-compact threshold", () => {
    act(() => {
      useChatStore.getState().replaceMessages([assistantWithUsage("a-1", { inputTokens: 190_000 })])
    })
    const { container } = render(<ContextUsageIndicator modelId="claude-sonnet-4-5" />) // 200k window
    const button = container.querySelector("button")
    expect(button?.className).toContain("text-red-500")
  })

  it("applies the green tint when the window is mostly empty", () => {
    act(() => {
      useChatStore.getState().replaceMessages([assistantWithUsage("a-1", { inputTokens: 1000 })])
    })
    const { container } = render(<ContextUsageIndicator modelId="claude-sonnet-4-5" />)
    const button = container.querySelector("button")
    expect(button?.className).toContain("text-emerald-500")
  })
})

describe("ContextWindowHeader", () => {
  it("renders the fill bar, level, threshold marker and compact label", () => {
    render(<ContextWindowHeader fraction={0.5} level="warn" used={100_000} max={200_000} />)
    const bar = screen.getByTestId("context-window-bar")
    expect(bar).toHaveAttribute("data-level", "warn")
    expect(screen.getByTestId("context-compact-marker")).toBeInTheDocument()
    // Compact-threshold label carries the 83.5% interpolation.
    expect(screen.getByText(/compactThreshold:/)).toBeInTheDocument()
  })

  it("uses the crit fill class at full occupancy", () => {
    const { container } = render(
      <ContextWindowHeader fraction={1} level="crit" used={200_000} max={200_000} />
    )
    const fill = container.querySelector('[data-testid="context-window-bar"] > div')
    expect(fill?.className).toContain("bg-red-500")
  })

  it("uses the ok fill class when nearly empty", () => {
    const { container } = render(
      <ContextWindowHeader fraction={0.05} level="ok" used={10_000} max={200_000} />
    )
    const fill = container.querySelector('[data-testid="context-window-bar"] > div')
    expect(fill?.className).toContain("bg-emerald-500")
  })
})

describe("UsageRow", () => {
  it("renders a label / value pair", () => {
    render(<UsageRow label="Input" slot={<span>123</span>} />)
    expect(screen.getByText("Input")).toBeInTheDocument()
    expect(screen.getByText("123")).toBeInTheDocument()
  })
})
