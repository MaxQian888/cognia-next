/**
 * @jest-environment jsdom
 */
import React from "react"
import { act, fireEvent, render, screen } from "@testing-library/react"
import type { UIMessage } from "ai"
import {
  CompactNowButton,
  ContextTurnSummary,
  ContextUsageIndicator,
  ContextWindowHeader,
  UsageRow,
} from "./context-usage-indicator"
import type { SessionUsageTotals } from "@/lib/claude/usage"
import { useChatStore } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"
import { compactSession } from "@/lib/claude/ipc"
import { ChatScopeProvider } from "@/components/chat/chat-scope-provider"

// Echo translation keys (with params appended) so assertions stay stable.
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

jest.mock("@/lib/claude/ipc", () => ({
  compactSession: jest.fn().mockResolvedValue(undefined),
}))

const mockedCompact = compactSession as unknown as jest.Mock

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
    useSettingsStore.setState({ settings: undefined as never })
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

  it("exposes the whole-session billed token total, distinct from window occupancy", () => {
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
    // Window = latest turn only (350); session = both turns billed (500).
    expect(node).toHaveAttribute("data-used-tokens", "350")
    expect(node).toHaveAttribute("data-session-tokens", "500")
  })

  it("skips re-rendering on message-array swaps that leave the usage signature unchanged", () => {
    const msgs = [assistantWithUsage("a-1", { inputTokens: 100, outputTokens: 50 })]
    act(() => {
      useChatStore.getState().replaceMessages(msgs)
    })
    const onRender = jest.fn()
    render(
      <React.Profiler id="ctx" onRender={onRender}>
        <ContextUsageIndicator modelId="claude-sonnet-4-6" />
      </React.Profiler>
    )
    const commitsAfterMount = onRender.mock.calls.length
    // Simulate streaming text-delta commits: fresh array ref + fresh trailing
    // message object, but same length and same `metadata.usage` reference —
    // exactly what `appendDelta` produces per token frame.
    act(() => {
      useChatStore.getState().replaceMessages([{ ...msgs[0]! }])
    })
    act(() => {
      useChatStore.getState().replaceMessages([{ ...msgs[0]! }])
    })
    expect(onRender.mock.calls.length).toBe(commitsAfterMount)
    // A real usage change (turn boundary) still refreshes the read-out.
    act(() => {
      useChatStore
        .getState()
        .replaceMessages([assistantWithUsage("a-1", { inputTokens: 200, outputTokens: 80 })])
    })
    expect(screen.getByTestId("context-usage-indicator")).toHaveAttribute("data-used-tokens", "280")
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

  it("backfills an estimated session cost when the SDK reports none (non-Anthropic path)", () => {
    act(() => {
      useChatStore
        .getState()
        .replaceMessages([assistantWithUsage("a-1", { inputTokens: 10_000, outputTokens: 5_000 })])
    })
    // gpt-4o carries no SDK total_cost_usd on the ai-sdk path, but it is priced.
    render(<ContextUsageIndicator modelId="gpt-4o" providerId="openai" />)
    const node = screen.getByTestId("context-usage-indicator")
    expect(Number(node.getAttribute("data-session-cost"))).toBeGreaterThan(0)
  })

  it("sizes the window from a custom provider's declared context length", () => {
    useSettingsStore.setState({
      settings: {
        customProviders: [
          { id: "cp", customModelMetadata: { big: { id: "big", contextLength: 500_000 } } },
        ],
      } as never,
    })
    act(() => {
      useChatStore.getState().replaceMessages([assistantWithUsage("a-1", { inputTokens: 100 })])
    })
    render(<ContextUsageIndicator modelId="big" providerId="cp" />)
    const node = screen.getByTestId("context-usage-indicator")
    // Without the override, "big" is unknown → 128k default; the custom
    // metadata lifts it to 500k.
    expect(node).toHaveAttribute("data-max-tokens", "500000")
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

  it("says the occupancy is unknown rather than drawing an empty window", () => {
    render(
      <ContextWindowHeader
        title="Context window"
        fraction={0}
        level="ok"
        used={0}
        max={200_000}
        reported={false}
      />
    )
    const bar = screen.getByTestId("context-window-bar")
    expect(bar).toHaveAttribute("data-reported", "false")
    // No fill, no threshold marker, and no "0%" claim anywhere.
    expect(bar.querySelector("div")).toBeNull()
    expect(screen.queryByTestId("context-compact-marker")).toBeNull()
    expect(screen.queryByText("0%")).toBeNull()
    expect(screen.getAllByText("—").length).toBeGreaterThan(0)
  })

  it("places the compact marker at the threshold the runtime actually reported", () => {
    render(
      <ContextWindowHeader
        title="Context window"
        fraction={0.5}
        level="ok"
        used={100_000}
        max={200_000}
        compaction={{ threshold: 0.92, enabled: true, source: "sdk" }}
      />
    )
    expect(screen.getByTestId("context-compact-marker")).toHaveStyle({ left: "92%" })
    expect(screen.getByText(/compactThreshold:/)).toHaveTextContent("92%")
  })

  it("drops the marker and names the owner when compaction is not ours", () => {
    render(
      <ContextWindowHeader
        title="Context window"
        fraction={0.5}
        level="ok"
        used={100_000}
        max={200_000}
        compaction={{ threshold: null, enabled: false, source: "agent-owned" }}
      />
    )
    expect(screen.queryByTestId("context-compact-marker")).toBeNull()
    expect(screen.getByText("compactAgentOwned")).toBeInTheDocument()
  })

  it("keeps the built-in sidecar threshold for callers that pass no policy", () => {
    render(<ContextWindowHeader fraction={0.5} level="warn" used={100_000} max={200_000} />)
    expect(screen.getByTestId("context-compact-marker")).toHaveStyle({ left: "83.5%" })
  })

  it("leads with the heading and a level-tinted percentage when titled", () => {
    render(
      <ContextWindowHeader
        title="Context window"
        fraction={0.5}
        level="warn"
        used={100_000}
        max={200_000}
      />
    )
    expect(screen.getByText("Context window")).toBeInTheDocument()
    const pct = screen.getByText("50%")
    expect(pct.className).toContain("text-amber-500")
    // The window size moves under the bar so the heading can own the top row.
    expect(screen.getByText("100K / 200K")).toBeInTheDocument()
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

describe("CompactNowButton", () => {
  beforeEach(() => mockedCompact.mockClear())

  it("requests compaction for the active session on click", () => {
    render(<CompactNowButton sessionId="s1" usedTokens={5000} />)
    fireEvent.click(screen.getByTestId("compact-now-button"))
    expect(mockedCompact).toHaveBeenCalledWith("s1")
  })

  it("uses the pane-owned handle control when the chat scope matches", () => {
    const compact = jest.fn(async () => undefined)
    render(
      <ChatScopeProvider sessionId="s1" compact={compact}>
        <CompactNowButton sessionId="s1" usedTokens={5000} />
      </ChatScopeProvider>
    )
    fireEvent.click(screen.getByTestId("compact-now-button"))
    expect(compact).toHaveBeenCalledTimes(1)
    expect(mockedCompact).not.toHaveBeenCalled()
  })

  it("is disabled with no active session", () => {
    render(<CompactNowButton sessionId={null} usedTokens={5000} />)
    const btn = screen.getByTestId("compact-now-button")
    expect(btn).toBeDisabled()
    fireEvent.click(btn)
    expect(mockedCompact).not.toHaveBeenCalled()
  })

  it("is disabled when the runtime owns its own compaction", () => {
    render(<CompactNowButton sessionId="s1" usedTokens={5000} supported={false} />)
    const btn = screen.getByTestId("compact-now-button")
    expect(btn).toBeDisabled()
    fireEvent.click(btn)
    expect(mockedCompact).not.toHaveBeenCalled()
  })

  it("is disabled when the window is empty", () => {
    render(<CompactNowButton sessionId="s1" usedTokens={0} />)
    expect(screen.getByTestId("compact-now-button")).toBeDisabled()
  })
})

describe("ContextUsageIndicator — SDK-authoritative usage", () => {
  beforeEach(() => {
    useChatStore.getState().clear()
    useSettingsStore.setState({ settings: undefined as never })
  })

  it("prefers the SDK window size + occupancy over the message estimate", () => {
    // A message estimate that would otherwise size the window to 1M / 350 used.
    act(() => {
      useChatStore
        .getState()
        .replaceMessages([assistantWithUsage("a-1", { inputTokens: 200, outputTokens: 150 })])
    })
    render(
      <ContextUsageIndicator
        modelId="claude-sonnet-4-6"
        sdkUsage={{ totalTokens: 4200, maxTokens: 8000, percentage: 0.525 }}
      />
    )
    const node = screen.getByTestId("context-usage-indicator")
    // SDK values win — not the catalog 1M window or the 350-token estimate.
    expect(node).toHaveAttribute("data-used-tokens", "4200")
    expect(node).toHaveAttribute("data-max-tokens", "8000")
  })

  it("shows the trigger as unknown, not 0%, when nothing reported usage", () => {
    render(<ContextUsageIndicator modelId="claude-sonnet-4-6" />)
    const trigger = screen.getByTestId("context-trigger")
    expect(trigger).toHaveAttribute("data-reported", "false")
    expect(trigger).toHaveTextContent("—")
    expect(trigger).not.toHaveTextContent("0%")
    expect(screen.getByTestId("context-ring")).toHaveAttribute("data-muted", "true")
  })

  it("sizes the window from the window the external agent itself reported", () => {
    act(() => {
      useChatStore
        .getState()
        .replaceMessages([
          assistantWithUsage("a-1", { contextTokens: 136_000, contextWindow: 272_000 }),
        ])
    })
    render(<ContextUsageIndicator modelId="claude-sonnet-4-6" />)
    const node = screen.getByTestId("context-usage-indicator")
    // Not the catalog's 1M guess for the session model.
    expect(node).toHaveAttribute("data-max-tokens", "272000")
    expect(node).toHaveAttribute("data-used-tokens", "136000")
  })

  it("never claims the sidecar's compaction policy over an external turn", () => {
    act(() => {
      useChatStore.getState().replaceMessages([
        {
          id: "a-1",
          role: "assistant",
          parts: [{ type: "text", text: "hi" }],
          metadata: {
            run: { providerId: "external" },
            usage: { contextTokens: 136_000, contextWindow: 272_000 },
          },
        } as unknown as UIMessage,
      ])
    })
    render(<ContextUsageIndicator modelId="claude-sonnet-4-6" />)
    const node = screen.getByTestId("context-usage-indicator")
    expect(node).toHaveAttribute("data-compaction", "agent-owned")
    expect(node).toHaveAttribute("data-window-source", "agent")
  })

  it("uses the built-in threshold for a turn the sidecar ran", () => {
    act(() => {
      useChatStore
        .getState()
        .replaceMessages([assistantWithUsage("a-1", { inputTokens: 100, outputTokens: 20 })])
    })
    render(<ContextUsageIndicator modelId="claude-sonnet-4-6" />)
    expect(screen.getByTestId("context-usage-indicator")).toHaveAttribute(
      "data-compaction",
      "builtin"
    )
  })

  it("falls back to the estimate when no SDK snapshot is supplied", () => {
    render(<ContextUsageIndicator modelId="claude-sonnet-4-6" sdkUsage={null} />)
    const node = screen.getByTestId("context-usage-indicator")
    expect(node).toHaveAttribute("data-max-tokens", "1000000")
  })
})

const totals = (over: Partial<SessionUsageTotals> = {}): SessionUsageTotals => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  totalCostUsd: 0,
  turns: 0,
  ...over,
})

describe("ContextTurnSummary", () => {
  it("keeps a value in every row before the first reply lands", () => {
    render(<ContextTurnSummary usage={null} session={totals()} />)
    // The regression: these three rows used to render a label with an empty
    // column next to it whenever the token count was zero/absent.
    for (const label of ["usageInput", "usageOutput", "usageCached"]) {
      const row = screen.getByText(label).parentElement
      expect(row?.textContent).toBe(`${label}—`)
    }
    expect(screen.getByText("noUsageYet")).toBeInTheDocument()
    expect(screen.getByTestId("session-total")).toHaveTextContent("—")
  })

  it("renders a measured zero as 0, not as unknown", () => {
    render(
      <ContextTurnSummary
        usage={{ inputTokens: 120, outputTokens: 0 }}
        session={totals({ inputTokens: 120, turns: 1 })}
      />
    )
    expect(screen.getByText("usageOutput").parentElement?.textContent).toBe("usageOutput0")
    expect(screen.getByText("usageInput").parentElement?.textContent).toContain("120")
  })

  it("prints an absent field as unknown even when a sibling field is present", () => {
    // ACP reports occupancy with no prompt/completion split; rendering the
    // missing halves as 0 would claim the turn spent nothing.
    render(
      <ContextTurnSummary
        usage={{ contextTokens: 136_000, contextWindow: 272_000 }}
        session={totals({ turns: 1 })}
        assistantTurns={1}
      />
    )
    for (const label of ["usageInput", "usageOutput", "usageCached"]) {
      expect(screen.getByText(label).parentElement?.textContent).toBe(`${label}—`)
    }
    expect(screen.getByTestId("session-total")).toHaveTextContent("—")
  })

  it("sums cache reads and cache writes into the cached row", () => {
    render(
      <ContextTurnSummary
        usage={{ cacheReadInputTokens: 1_200, cacheCreationInputTokens: 800 }}
        session={totals({ turns: 1 })}
      />
    )
    // Previously always blank: the vendored slot read a field the indicator
    // never populated, so the cache row rendered `null` at any size.
    expect(screen.getByText("usageCached").parentElement?.textContent).toContain("2K")
  })

  it("prices a slice when the model is known and drops the hint when it is not", () => {
    const { rerender } = render(
      <ContextTurnSummary
        usage={{ inputTokens: 1_000_000 }}
        session={totals({ turns: 1 })}
        modelId="claude-sonnet-4-5"
        providerId="anthropic"
      />
    )
    expect(screen.getByText("usageInput").parentElement?.textContent).toMatch(/\$/)
    rerender(
      <ContextTurnSummary usage={{ inputTokens: 1_000_000 }} session={totals({ turns: 1 })} />
    )
    expect(screen.getByText("usageInput").parentElement?.textContent).not.toMatch(/\$/)
  })

  it("distinguishes an unreporting runtime from a session that has not run", () => {
    // External-agent turns land with no usage metadata at all; calling that
    // "nothing has happened yet" mislabels which fact is missing.
    const { rerender } = render(<ContextTurnSummary usage={null} session={totals()} />)
    expect(screen.getByText("noUsageYet")).toBeInTheDocument()
    rerender(<ContextTurnSummary usage={null} session={totals()} assistantTurns={3} />)
    expect(screen.getByText("usageNotReported")).toBeInTheDocument()
  })

  it("drops the empty-state hint once a turn has been recorded", () => {
    render(
      <ContextTurnSummary
        usage={{ inputTokens: 10, outputTokens: 4 }}
        session={totals({ inputTokens: 10, outputTokens: 4, turns: 2 })}
      />
    )
    expect(screen.queryByText("noUsageYet")).toBeNull()
    expect(screen.queryByText("usageNotReported")).toBeNull()
    expect(screen.getByTestId("session-total")).toHaveTextContent("14")
  })
})
