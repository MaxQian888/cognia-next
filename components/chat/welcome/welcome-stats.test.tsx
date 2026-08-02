/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { AppSettings } from "@cognia/agent-config-types"
import { EMPTY_ACTIVITY_STATS, type ActivityStats } from "@/lib/usage/activity-stats"
import { DEFAULT_WELCOME_STATS_PREFS } from "@/lib/chat/welcome-stats-prefs"

// next-intl is globally mocked against en.json in jest.setup.ts.

const save = jest.fn()
const storeState: { settings: Partial<AppSettings> } = { settings: {} }
jest.mock("@/stores/settings", () => ({
  useSettingsStore: jest.fn((selector: (s: unknown) => unknown) =>
    selector({ settings: storeState.settings, save })
  ),
}))

jest.mock("@/hooks/usage/use-activity-stats", () => ({ useActivityStats: jest.fn() }))

// The heatmap has its own suite; a stub keeps this one about the dashboard.
jest.mock("@/components/usage/usage-heatmap", () => ({
  UsageHeatmap: ({ rangeDays }: { rangeDays: number }) => (
    <div data-testid="mock-heatmap">{rangeDays}</div>
  ),
}))

import { useActivityStats } from "@/hooks/usage/use-activity-stats"
import { WelcomeStats } from "./welcome-stats"

const mockUseActivityStats = useActivityStats as jest.Mock

const NOW = new Date(2026, 4, 20, 12).getTime()

const STATS: ActivityStats = {
  turns: 42,
  sessions: 7,
  totalTokens: 1_500_000,
  costUsd: 12.5,
  durationMs: 60_000,
  activeDays: 5,
  currentStreak: 3,
  longestStreak: 9,
  peakHour: 19,
  topModel: "claude-opus-5",
}

function mockHook(over: Partial<ReturnType<typeof useActivityStats>> = {}) {
  mockUseActivityStats.mockReturnValue({
    loading: false,
    stats: STATS,
    daily: [{ date: "2026-05-20", tokens: 100, cost: 1, requests: 2 }],
    models: [
      {
        model: "claude-opus-5",
        turns: 30,
        inputTokens: 900_000,
        outputTokens: 100_000,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 10,
        durationMs: 0,
        reasoningTokens: 0,
      },
      {
        model: "claude-haiku-4-5",
        turns: 12,
        inputTokens: 40_000,
        outputTokens: 10_000,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 2.5,
        durationMs: 0,
        reasoningTokens: 0,
      },
    ],
    now: NOW,
    ...over,
  })
}

beforeEach(() => {
  save.mockReset()
  storeState.settings = {}
  mockUseActivityStats.mockReset()
  mockHook()
})

describe("<WelcomeStats />", () => {
  it("renders the default tile set over the default window", () => {
    render(<WelcomeStats />)
    expect(screen.getByTestId("welcome-stats")).toBeInTheDocument()
    for (const id of DEFAULT_WELCOME_STATS_PREFS.tiles) {
      expect(screen.getByTestId(`welcome-stat-${id}`)).toBeInTheDocument()
    }
    // `longestStreak` is off by default — available, not shown.
    expect(screen.queryByTestId("welcome-stat-longestStreak")).not.toBeInTheDocument()
    expect(mockUseActivityStats).toHaveBeenCalledWith(DEFAULT_WELCOME_STATS_PREFS.rangeDays)
  })

  it("formats each tile with the shared usage formatters", () => {
    render(<WelcomeStats />)
    expect(screen.getByTestId("welcome-stat-sessions")).toHaveTextContent("7")
    expect(screen.getByTestId("welcome-stat-turns")).toHaveTextContent("42")
    expect(screen.getByTestId("welcome-stat-tokens")).toHaveTextContent("1.5M")
    expect(screen.getByTestId("welcome-stat-cost")).toHaveTextContent("$12.50")
    expect(screen.getByTestId("welcome-stat-activeDays")).toHaveTextContent("5")
    expect(screen.getByTestId("welcome-stat-currentStreak")).toHaveTextContent("3d")
    expect(screen.getByTestId("welcome-stat-topModel")).toHaveTextContent("claude-opus-5")
    // Peak hour is locale-formatted rather than a hard-coded clock string.
    expect(screen.getByTestId("welcome-stat-peakHour")).toHaveTextContent("7")
  })

  it("renders the opt-in longest-streak tile when it is turned on", () => {
    storeState.settings = { welcomeStats: { tiles: ["longestStreak"] } }
    render(<WelcomeStats />)
    expect(screen.getByTestId("welcome-stat-longestStreak")).toHaveTextContent("9d")
  })

  it("shows an em dash when there is no peak hour or top model", () => {
    mockHook({ stats: { ...STATS, peakHour: null, topModel: null } })
    render(<WelcomeStats />)
    expect(screen.getByTestId("welcome-stat-peakHour")).toHaveTextContent("—")
    expect(screen.getByTestId("welcome-stat-topModel")).toHaveTextContent("—")
  })

  it("draws the heatmap over the same window the tiles use", () => {
    storeState.settings = { welcomeStats: { rangeDays: 7 } }
    render(<WelcomeStats />)
    expect(screen.getByTestId("mock-heatmap")).toHaveTextContent("7")
  })

  it("skips the heatmap when it is turned off", () => {
    storeState.settings = { welcomeStats: { heatmap: false } }
    render(<WelcomeStats />)
    expect(screen.queryByTestId("mock-heatmap")).not.toBeInTheDocument()
    expect(screen.getByTestId("welcome-stats-grid")).toBeInTheDocument()
  })

  it("skips the grid when every tile is turned off", () => {
    storeState.settings = { welcomeStats: { tiles: [] } }
    render(<WelcomeStats />)
    expect(screen.queryByTestId("welcome-stats-grid")).not.toBeInTheDocument()
    expect(screen.getByTestId("mock-heatmap")).toBeInTheDocument()
  })

  it("renders nothing at all once dismissed", () => {
    storeState.settings = { welcomeStats: { enabled: false } }
    render(<WelcomeStats />)
    expect(screen.queryByTestId("welcome-stats")).not.toBeInTheDocument()
  })

  it("shows a skeleton while the first Dexie snapshot is in flight", () => {
    mockHook({ loading: true, stats: { ...EMPTY_ACTIVITY_STATS } })
    render(<WelcomeStats />)
    expect(screen.getByTestId("welcome-stats-loading")).toBeInTheDocument()
    expect(screen.queryByTestId("welcome-stats-grid")).not.toBeInTheDocument()
  })

  it("explains an empty window instead of showing a grid of zeros", () => {
    mockHook({ stats: { ...EMPTY_ACTIVITY_STATS }, daily: [], models: [] })
    render(<WelcomeStats />)
    expect(screen.getByTestId("welcome-stats-empty")).toBeInTheDocument()
    expect(screen.queryByTestId("welcome-stats-grid")).not.toBeInTheDocument()
    // The controls stay, so the user can widen the window from here.
    expect(screen.getByTestId("welcome-stats-range")).toBeInTheDocument()
  })

  describe("controls", () => {
    it("persists a new window", async () => {
      const user = userEvent.setup()
      render(<WelcomeStats />)
      await user.click(screen.getByTestId("welcome-stats-range-7"))
      expect(save).toHaveBeenCalledWith({
        welcomeStats: { ...DEFAULT_WELCOME_STATS_PREFS, rangeDays: 7 },
      })
    })

    it("ignores a toggle-group deselect instead of writing an invalid window", async () => {
      const user = userEvent.setup()
      storeState.settings = { welcomeStats: { rangeDays: 7 } }
      render(<WelcomeStats />)
      // Clicking the active item deselects it in a single-select ToggleGroup.
      await user.click(screen.getByTestId("welcome-stats-range-7"))
      expect(save).not.toHaveBeenCalled()
    })

    it("switches to the per-model face and persists it", async () => {
      const user = userEvent.setup()
      render(<WelcomeStats />)
      await user.click(screen.getByTestId("welcome-stats-view-models"))
      expect(save).toHaveBeenCalledWith({
        welcomeStats: { ...DEFAULT_WELCOME_STATS_PREFS, view: "models" },
      })
    })

    it("renders the per-model breakdown when that face is active", () => {
      storeState.settings = { welcomeStats: { view: "models" } }
      render(<WelcomeStats />)
      expect(screen.getByTestId("welcome-stats-models")).toBeInTheDocument()
      expect(screen.getByTestId("welcome-stats-model-claude-opus-5")).toHaveTextContent("$10.00")
      expect(screen.queryByTestId("welcome-stats-grid")).not.toBeInTheDocument()
    })

    it("explains an empty model list", () => {
      storeState.settings = { welcomeStats: { view: "models" } }
      mockHook({ models: [] })
      render(<WelcomeStats />)
      expect(screen.getByTestId("welcome-stats-models-empty")).toBeInTheDocument()
    })

    it("hides the whole panel from the ✕", async () => {
      const user = userEvent.setup()
      render(<WelcomeStats />)
      await user.click(screen.getByRole("button", { name: "Hide this section" }))
      expect(save).toHaveBeenCalledWith({
        welcomeStats: { ...DEFAULT_WELCOME_STATS_PREFS, enabled: false },
      })
    })
  })

  describe("customizer", () => {
    it("adds a tile in canonical order rather than at the end", async () => {
      const user = userEvent.setup()
      storeState.settings = { welcomeStats: { tiles: ["sessions", "topModel"] } }
      render(<WelcomeStats />)
      await user.click(screen.getByTestId("welcome-stats-customize"))
      await user.click(screen.getByTestId("welcome-stats-opt-tokens"))
      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({
          welcomeStats: expect.objectContaining({
            tiles: ["sessions", "tokens", "topModel"],
          }),
        })
      )
    })

    it("removes a tile", async () => {
      const user = userEvent.setup()
      storeState.settings = { welcomeStats: { tiles: ["sessions", "topModel"] } }
      render(<WelcomeStats />)
      await user.click(screen.getByTestId("welcome-stats-customize"))
      await user.click(screen.getByTestId("welcome-stats-opt-sessions"))
      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({
          welcomeStats: expect.objectContaining({ tiles: ["topModel"] }),
        })
      )
    })

    it("toggles the heatmap", async () => {
      const user = userEvent.setup()
      render(<WelcomeStats />)
      await user.click(screen.getByTestId("welcome-stats-customize"))
      await user.click(screen.getByTestId("welcome-stats-opt-heatmap"))
      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({
          welcomeStats: expect.objectContaining({ heatmap: false }),
        })
      )
    })
  })
})
