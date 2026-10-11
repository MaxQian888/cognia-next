/**
 * @jest-environment jsdom
 */

import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { DEFAULT_GLANCE_PANEL_SETTINGS } from "@/lib/glance/presets"
import type { GlanceRequestBody } from "@/lib/glance/requests"
import {
  GLANCE_SNAPSHOT_VERSION,
  type GlanceSnapshotV1,
  type GlanceUsageSlice,
} from "@/lib/glance/snapshot"
import { formatCompactTokens } from "@/lib/usage/status-snapshot"

import { GlanceProvider, type GlanceContextValue } from "../glance-context"
import { GlanceUsageModule } from "./glance-usage-module"

const NOW = 1_700_000_000_000

function makeUsage(overrides: Partial<GlanceUsageSlice> = {}): GlanceUsageSlice {
  return {
    updatedAt: NOW,
    scope: "cognia",
    showSpend: false,
    workspaceFiltered: false,
    freshness: "fresh",
    today: { tokens: 1_500, knownCostUsd: 0.5, turns: 3 },
    week: { tokens: 20_000, knownCostUsd: 4, turns: 20 },
    month: { tokens: 1_200_000, knownCostUsd: 42, turns: 120 },
    unpricedTurns: 0,
    sparkline: Array.from({ length: 7 }, (_, i) => ({
      day: `2026-10-0${i + 1}`,
      tokens: (i + 1) * 100,
      knownCostUsd: 0,
      turns: i,
    })),
    topModel: { id: "claude-sonnet", tokens: 900_000, knownCostUsd: 30 },
    providers: [
      { id: "anthropic", tokens: 800_000, knownCostUsd: 20, share: 0.7 },
      { id: "openai", tokens: 300_000, knownCostUsd: 10, share: 0.3 },
    ],
    budget: null,
    ...overrides,
  }
}

function makeSnapshot(usage: GlanceUsageSlice | null): GlanceSnapshotV1 {
  return {
    version: GLANCE_SNAPSHOT_VERSION,
    epoch: 1,
    revision: 1,
    generatedAt: NOW,
    config: DEFAULT_GLANCE_PANEL_SETTINGS,
    workspace: null,
    when: {} as GlanceSnapshotV1["when"],
    actions: [],
    fleet: null,
    usage,
    quota: null,
    agenda: null,
    activity: null,
    recents: null,
    pet: null,
  }
}

function setup(
  usage: GlanceUsageSlice | null,
  size: "compact" | "standard" | "expanded" = "standard"
) {
  const route = jest.fn<void, [GlanceRequestBody]>()
  const send = jest.fn<Promise<string | null>, [GlanceRequestBody]>(async () => null)
  const value: GlanceContextValue = {
    snapshot: makeSnapshot(usage),
    platform: "desktop",
    width: "standard",
    now: NOW,
    send,
    route,
  }
  const utils = render(
    <GlanceProvider value={value}>
      <GlanceUsageModule size={size} />
    </GlanceProvider>
  )
  return { ...utils, route, send, user: userEvent.setup() }
}

describe("GlanceUsageModule", () => {
  it("shows a loading line while the usage slice is null", () => {
    setup(null)
    expect(screen.getByText("Reading usage…")).toBeInTheDocument()
  })

  describe("compact", () => {
    it("shows today and 7 day tokens and routes to the usage page", async () => {
      const { route, user } = setup(makeUsage(), "compact")
      expect(screen.getByText(formatCompactTokens(1_500))).toBeInTheDocument()
      expect(screen.getByText(formatCompactTokens(20_000))).toBeInTheDocument()
      expect(screen.getByRole("img", { name: "Tokens over the last 7 days" })).toBeInTheDocument()
      await user.click(screen.getByRole("button", { name: "Open usage" }))
      expect(route).toHaveBeenCalledWith({ kind: "open-owner", owner: "usage" })
    })

    it("appends today's spend only when spend is shown", () => {
      const { unmount } = setup(makeUsage(), "compact")
      expect(screen.queryByText("$0.50")).not.toBeInTheDocument()
      unmount()
      setup(makeUsage({ showSpend: true }), "compact")
      expect(screen.getByText("$0.50")).toBeInTheDocument()
    })
  })

  describe("standard", () => {
    it("shows today, 7 days and 30 days token values", () => {
      setup(makeUsage())
      const section = screen.getByRole("region", { name: "Usage" })
      expect(within(section).getByText("Today")).toBeInTheDocument()
      expect(within(section).getByText("7 days")).toBeInTheDocument()
      expect(within(section).getByText("30 days")).toBeInTheDocument()
      expect(within(section).getByText("1.5k")).toBeInTheDocument()
      expect(within(section).getByText("20k")).toBeInTheDocument()
      expect(within(section).getByText("1.2M")).toBeInTheDocument()
    })

    it("shows turns beneath the tokens while spend is hidden", () => {
      setup(makeUsage())
      expect(screen.getByText("3 turns")).toBeInTheDocument()
      expect(screen.getByText("20 turns")).toBeInTheDocument()
      expect(screen.getByText("120 turns")).toBeInTheDocument()
      expect(screen.queryByText("$0.50")).not.toBeInTheDocument()
      expect(screen.getByText("Spend is hidden")).toBeInTheDocument()
    })

    it("says no turns for an empty window", () => {
      setup(makeUsage({ today: { tokens: 0, knownCostUsd: 0, turns: 0 } }))
      expect(screen.getByText("no turns")).toBeInTheDocument()
    })

    it("shows money beneath the tokens when spend is shown", () => {
      setup(makeUsage({ showSpend: true }))
      expect(screen.getByText("$0.50")).toBeInTheDocument()
      expect(screen.getByText("$4")).toBeInTheDocument()
      expect(screen.getByText("$42")).toBeInTheDocument()
      expect(screen.queryByText("3 turns")).not.toBeInTheDocument()
    })

    it("marks spend as a lower bound with a leading ≥ when turns are unpriced", () => {
      setup(makeUsage({ showSpend: true, unpricedTurns: 4 }))
      expect(screen.getByText("≥$0.50")).toBeInTheDocument()
      expect(screen.getByText("≥$4")).toBeInTheDocument()
      expect(
        screen.getByText("4 turns have no price, so spend is a lower bound")
      ).toBeInTheDocument()
    })

    it("shows a dash instead of $0 when every turn in a window is unpriced", () => {
      setup(
        makeUsage({
          showSpend: true,
          unpricedTurns: 3,
          today: { tokens: 900, knownCostUsd: 0, turns: 3 },
        })
      )
      expect(screen.getByText("—")).toBeInTheDocument()
    })

    it("shows the top model with its tokens, or a no-usage line", () => {
      const { unmount } = setup(makeUsage())
      expect(screen.getByText("claude-sonnet")).toBeInTheDocument()
      expect(screen.getByText("900k")).toBeInTheDocument()
      unmount()
      setup(makeUsage({ topModel: null }))
      expect(screen.getByText("No usage in the last 30 days")).toBeInTheDocument()
    })

    it("tags workspace-filtered usage", () => {
      const { unmount } = setup(makeUsage())
      expect(screen.queryByText("This workspace")).not.toBeInTheDocument()
      unmount()
      setup(makeUsage({ workspaceFiltered: true }))
      expect(screen.getByText("This workspace")).toBeInTheDocument()
    })

    it("flags stale and partial freshness with an explanatory title", () => {
      const { unmount } = setup(makeUsage({ freshness: "stale" }))
      expect(screen.getByText("Not current")).toHaveAttribute(
        "title",
        "Some tools' session files couldn't be read recently."
      )
      unmount()
      setup(makeUsage({ freshness: "partial" }))
      expect(screen.getByText("Partial")).toHaveAttribute(
        "title",
        "Some tools' session files couldn't be read."
      )
    })

    it("routes a stat click to the usage page", async () => {
      const { route, user } = setup(makeUsage())
      await user.click(screen.getAllByRole("button", { name: "Open usage" })[0]!)
      expect(route).toHaveBeenCalledWith({ kind: "open-owner", owner: "usage" })
    })

    it("does not list providers outside the expanded size", () => {
      setup(makeUsage())
      expect(screen.queryByRole("meter", { name: /share of tokens/ })).not.toBeInTheDocument()
    })
  })

  describe("budget and spend toggle", () => {
    it("offers Show spend while spend is hidden and sends set-show-spend true", async () => {
      const { send, user } = setup(makeUsage())
      await user.click(screen.getByRole("button", { name: "Show spend" }))
      expect(send).toHaveBeenCalledWith({ kind: "set-show-spend", showSpend: true })
    })

    it("offers Hide spend while spend is shown and sends set-show-spend false", async () => {
      const { send, user } = setup(makeUsage({ showSpend: true }))
      await user.click(screen.getByRole("button", { name: "Hide spend" }))
      expect(send).toHaveBeenCalledWith({ kind: "set-show-spend", showSpend: false })
    })

    it("says no budget is set when spend is shown without a budget", () => {
      setup(makeUsage({ showSpend: true }))
      expect(screen.getByText("No budget set")).toBeInTheDocument()
    })

    it("shows the budget meter with its percentage and period", () => {
      setup(
        makeUsage({ showSpend: true, budget: { ratio: 0.85, period: "month", blocked: false } })
      )
      expect(screen.getByText("Monthly budget")).toBeInTheDocument()
      expect(screen.getByRole("meter", { name: "Budget used" })).toHaveAttribute(
        "aria-valuenow",
        "85"
      )
      expect(screen.getByText("85%")).toBeInTheDocument()
      expect(screen.getByRole("button", { name: "Hide spend" })).toBeInTheDocument()
    })

    it("labels a daily budget", () => {
      setup(makeUsage({ showSpend: true, budget: { ratio: 0.2, period: "day", blocked: false } }))
      expect(screen.getByText("Daily budget")).toBeInTheDocument()
    })

    it("hides the budget while spend is hidden", () => {
      setup(
        makeUsage({ showSpend: false, budget: { ratio: 0.5, period: "month", blocked: false } })
      )
      expect(screen.queryByRole("meter", { name: "Budget used" })).not.toBeInTheDocument()
    })
  })

  describe("usage scope (ADR-0165 consent)", () => {
    it("exposes a Cognia / All tools radio group reflecting the current scope", () => {
      setup(makeUsage())
      const group = screen.getByRole("radiogroup", { name: "Count usage from" })
      expect(within(group).getByRole("radio", { name: "Cognia" })).toBeChecked()
      expect(within(group).getByRole("radio", { name: "All tools" })).not.toBeChecked()
    })

    it("shows the consent notice for All tools and does not send until confirmed", async () => {
      const { send, user } = setup(makeUsage())
      await user.click(screen.getByRole("radio", { name: "All tools" }))
      expect(screen.getByText(/reads the session files of Claude Code, Codex/)).toBeInTheDocument()
      expect(screen.getByRole("radio", { name: "All tools" })).toBeChecked()
      expect(send).not.toHaveBeenCalled()
      // The stats are replaced by the notice while it is open.
      expect(screen.queryByText("1.5k")).not.toBeInTheDocument()
    })

    it("sends set-usage-scope all-tools once the consent is confirmed", async () => {
      const { send, user } = setup(makeUsage())
      await user.click(screen.getByRole("radio", { name: "All tools" }))
      await user.click(screen.getByRole("button", { name: "Count all tools" }))
      expect(send).toHaveBeenCalledTimes(1)
      expect(send).toHaveBeenCalledWith({ kind: "set-usage-scope", scope: "all-tools" })
      expect(screen.queryByText(/reads the session files/)).not.toBeInTheDocument()
    })

    it("returns to the stats without sending when the consent is cancelled", async () => {
      const { send, user } = setup(makeUsage())
      await user.click(screen.getByRole("radio", { name: "All tools" }))
      await user.click(screen.getByRole("button", { name: "Not now" }))
      expect(send).not.toHaveBeenCalled()
      expect(screen.queryByText(/reads the session files/)).not.toBeInTheDocument()
      expect(screen.getByText("1.5k")).toBeInTheDocument()
      expect(screen.getByRole("radio", { name: "Cognia" })).toBeChecked()
    })

    it("closes the notice without sending when Cognia is picked while confirming", async () => {
      const { send, user } = setup(makeUsage())
      await user.click(screen.getByRole("radio", { name: "All tools" }))
      await user.click(screen.getByRole("radio", { name: "Cognia" }))
      expect(send).not.toHaveBeenCalled()
      expect(screen.queryByText(/reads the session files/)).not.toBeInTheDocument()
    })

    it("sends set-usage-scope cognia immediately when switching back", async () => {
      const { send, user } = setup(makeUsage({ scope: "all-tools" }))
      expect(screen.getByRole("radio", { name: "All tools" })).toBeChecked()
      await user.click(screen.getByRole("radio", { name: "Cognia" }))
      expect(send).toHaveBeenCalledWith({ kind: "set-usage-scope", scope: "cognia" })
      expect(screen.queryByText(/reads the session files/)).not.toBeInTheDocument()
    })

    it("does nothing when the current scope is picked again", async () => {
      const { send, user } = setup(makeUsage({ scope: "all-tools" }))
      await user.click(screen.getByRole("radio", { name: "All tools" }))
      expect(send).not.toHaveBeenCalled()
      expect(screen.queryByText(/reads the session files/)).not.toBeInTheDocument()
    })
  })

  describe("expanded", () => {
    it("lists provider shares with meters", () => {
      setup(makeUsage(), "expanded")
      expect(screen.getByText("anthropic")).toBeInTheDocument()
      expect(screen.getByText("70%")).toBeInTheDocument()
      expect(screen.getByRole("meter", { name: "anthropic share of tokens" })).toHaveAttribute(
        "aria-valuenow",
        "70"
      )
      expect(screen.getByRole("meter", { name: "openai share of tokens" })).toHaveAttribute(
        "aria-valuenow",
        "30"
      )
    })

    it("omits the provider list when there are no providers", () => {
      setup(makeUsage({ providers: [] }), "expanded")
      expect(screen.queryByRole("meter", { name: /share of tokens/ })).not.toBeInTheDocument()
    })
  })
})
