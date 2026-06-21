import React from "react"
import { render } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"

import { LimitsPanel } from "./LimitsPanel"
import type { SessionAnalysis } from "../../format/usage-analysis"
import type { ProviderLimits } from "@/types/subscription"

const NOW = 1_700_000_000_000

const analysis: SessionAnalysis = {
  turns: 4,
  highContextTurns: 2,
  highContextPct: 50,
  highContextThreshold: 150_000,
  dispatchCalls: 1,
  totalToolCalls: 6,
  topTools: [],
}

const anthropic: ProviderLimits = {
  provider: "anthropic",
  accountId: "anthropic",
  accountLabel: "Max",
  fetchedAt: NOW,
  meters: [
    { id: "session", kind: "window", usedPct: 21, resetAt: NOW + 2 * 3600_000, status: "ok" },
    { id: "weekly", kind: "window", usedPct: 5, resetAt: NOW + 5 * 86_400_000, status: "ok" },
  ],
}

const kimi: ProviderLimits = {
  provider: "moonshot",
  accountId: "moonshot",
  fetchedAt: NOW,
  meters: [
    {
      id: "credit",
      kind: "balance",
      usedPct: null,
      remaining: 88.5,
      currency: "CNY",
      status: "ok",
    },
  ],
}

describe("LimitsPanel", () => {
  beforeEach(() => __resetInk())

  it("renders bars, percents, reset countdowns and credit for every account", () => {
    const { container } = render(
      <LimitsPanel snapshots={[anthropic, kimi]} analysis={analysis} now={NOW} onClose={() => {}} />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("Subscription limits")
    expect(text).toContain("anthropic · Max")
    expect(text).toContain("Current session")
    expect(text).toContain("21% used")
    expect(text).toContain("Current week (all models)")
    expect(text).toContain("Resets in 2h 0m")
    // credit-based account
    expect(text).toContain("moonshot")
    expect(text).toContain("Credit balance")
    expect(text).toContain("¥88.50 left")
    // local session footer
    expect(text).toContain("Turns this session: 4")
    expect(text).toContain("1 subagent dispatch")
  })

  it("renders the live API rate-limit block when a reading is present", () => {
    const { container } = render(
      <LimitsPanel
        snapshots={[]}
        analysis={analysis}
        now={NOW}
        rateLimits={{
          capturedAt: NOW,
          meters: [
            {
              kind: "tokens",
              label: "Tokens",
              unit: "tok",
              limit: 1_000_000,
              remaining: 12_345,
              usedPct: 99,
              resetAt: NOW + 5 * 60_000,
            },
          ],
        }}
        onClose={() => {}}
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("API rate limits (live)")
    expect(text).toContain("Tokens")
    expect(text).toContain("12,345 tok left")
    expect(text).toContain("Resets in 5m")
  })

  it("omits the live rate-limit block when no reading is present", () => {
    const { container } = render(
      <LimitsPanel snapshots={[anthropic]} analysis={analysis} now={NOW} onClose={() => {}} />
    )
    expect(container.textContent).not.toContain("API rate limits (live)")
  })

  it("renders the empty-state note when nothing is configured", () => {
    const { container } = render(
      <LimitsPanel snapshots={[]} analysis={analysis} now={NOW} onClose={() => {}} />
    )
    expect(container.textContent).toContain("No subscription limit data")
  })

  it("badges the active provider and always shows it even with no data", () => {
    // The active provider returned no usable source → empty meters. It must still
    // render (badged `● active`) rather than collapse to just the credit provider.
    const activeEmpty: ProviderLimits = {
      provider: "anthropic",
      accountId: "anthropic",
      accountLabel: "anthropic",
      fetchedAt: NOW,
      meters: [],
    }
    const { container } = render(
      <LimitsPanel
        snapshots={[activeEmpty, kimi]}
        analysis={analysis}
        now={NOW}
        activeProvider="anthropic"
        onClose={() => {}}
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("● active")
    expect(text).toContain("No limit data for this provider.")
    // The credit provider is still listed, but it is NOT marked active.
    expect(text).toContain("Credit balance")
  })

  it("points an OpenCode active provider at the console instead of a bare no-data line", () => {
    const opencodeEmpty: ProviderLimits = {
      provider: "opencode-go",
      accountId: "opencode-go",
      accountLabel: "opencode-go",
      fetchedAt: NOW,
      meters: [],
    }
    const { container } = render(
      <LimitsPanel
        snapshots={[opencodeEmpty]}
        analysis={analysis}
        now={NOW}
        activeProvider="opencode-go"
        onClose={() => {}}
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("opencode.ai")
    expect(text).not.toContain("No limit data for this provider.")
  })

  it("renders a depleted credit balance as 'depleted' with no misleading bar", () => {
    const depleted: ProviderLimits = {
      provider: "deepseek",
      accountId: "deepseek",
      fetchedAt: NOW,
      meters: [
        {
          id: "credit",
          kind: "balance",
          usedPct: null,
          remaining: -0.01,
          currency: "CNY",
          status: "exceeded",
        },
      ],
    }
    const { container } = render(
      <LimitsPanel snapshots={[depleted]} analysis={analysis} now={NOW} onClose={() => {}} />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("Credit balance")
    expect(text).toContain("depleted")
    expect(text).not.toContain("¥-0.01")
    // Pure-credit meters render no bar glyphs at all.
    expect(text).not.toContain("█")
  })

  it("does not show the onboarding hint when at least one account has data", () => {
    const { container } = render(
      <LimitsPanel
        snapshots={[anthropic]}
        analysis={analysis}
        now={NOW}
        activeProvider="anthropic"
        onClose={() => {}}
      />
    )
    expect(container.textContent).not.toContain("No subscription limit data")
  })

  it("surfaces a provider error inline", () => {
    const errored: ProviderLimits = {
      provider: "moonshot",
      accountId: "moonshot",
      fetchedAt: NOW,
      meters: [],
      error: "network down",
    }
    const { container } = render(
      <LimitsPanel snapshots={[errored]} analysis={analysis} now={NOW} onClose={() => {}} />
    )
    expect(container.textContent).toContain("network down")
  })

  it("closes on escape", () => {
    const onClose = jest.fn()
    render(<LimitsPanel snapshots={[anthropic]} analysis={analysis} now={NOW} onClose={onClose} />)
    __fireInput("", { escape: true })
    expect(onClose).toHaveBeenCalled()
  })

  it("omits the high-context/dispatch lines when zero and pluralizes dispatches", () => {
    const quiet: SessionAnalysis = { ...analysis, highContextPct: 0, dispatchCalls: 0 }
    const { container, rerender } = render(
      <LimitsPanel snapshots={[anthropic]} analysis={quiet} now={NOW} onClose={() => {}} />
    )
    expect(container.textContent).not.toContain("subagent dispatch")
    rerender(
      <LimitsPanel
        snapshots={[anthropic]}
        analysis={{ ...analysis, dispatchCalls: 3 }}
        now={NOW}
        onClose={() => {}}
      />
    )
    expect(container.textContent).toContain("3 subagent dispatches")
  })

  it("uses just the provider as the header when the label equals the provider", () => {
    const labelEqualsProvider: ProviderLimits = { ...kimi, accountLabel: "moonshot" }
    const { container } = render(
      <LimitsPanel
        snapshots={[labelEqualsProvider]}
        analysis={analysis}
        now={NOW}
        onClose={() => {}}
      />
    )
    expect(container.textContent).not.toContain("moonshot · moonshot")
  })
})
