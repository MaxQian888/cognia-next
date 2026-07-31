import { render, screen, fireEvent } from "@testing-library/react"

const resetMock = jest.fn()
let settings: { searchUsageStats?: Record<string, unknown> } = {}

jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T,>(
    selector: (s: { settings: typeof settings; resetSearchUsageStats: typeof resetMock }) => T
  ) => selector({ settings, resetSearchUsageStats: resetMock }),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const mockLogInfo = jest.fn()
jest.mock("@cognia/logging", () => ({
  createLogger: () => ({
    info: (...args: unknown[]) => mockLogInfo(...args),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
    fatal: jest.fn(),
  }),
}))

import { SearchUsagePanel } from "./search-usage-panel"

beforeEach(() => {
  resetMock.mockReset()
  mockLogInfo.mockReset()
  settings = {}
})

describe("SearchUsagePanel", () => {
  it("shows noData when no searches", () => {
    render(<SearchUsagePanel />)
    expect(screen.getByText("noData")).toBeInTheDocument()
  })

  it("renders totals and provider rows", () => {
    settings = {
      searchUsageStats: {
        tavily: {
          searchCount: 10,
          totalResponseTime: 1000,
          errorCount: 1,
          lastUsedAt: Date.now(),
        },
        perplexity: {
          searchCount: 5,
          totalResponseTime: 500,
          errorCount: 0,
          lastUsedAt: null,
        },
        exa: { searchCount: 0, totalResponseTime: 0, errorCount: 0, lastUsedAt: null },
        searchapi: { searchCount: 0, totalResponseTime: 0, errorCount: 0, lastUsedAt: null },
        serper: { searchCount: 0, totalResponseTime: 0, errorCount: 0, lastUsedAt: null },
        serpapi: { searchCount: 0, totalResponseTime: 0, errorCount: 0, lastUsedAt: null },
        bing: { searchCount: 0, totalResponseTime: 0, errorCount: 0, lastUsedAt: null },
        google: { searchCount: 0, totalResponseTime: 0, errorCount: 0, lastUsedAt: null },
        "google-ai": { searchCount: 0, totalResponseTime: 0, errorCount: 0, lastUsedAt: null },
        brave: { searchCount: 0, totalResponseTime: 0, errorCount: 0, lastUsedAt: null },
      },
    }
    render(<SearchUsagePanel />)
    expect(screen.getByText("15")).toBeInTheDocument()
    expect(screen.getByText("100ms")).toBeInTheDocument()
    expect(screen.getAllByText("Tavily").length).toBeGreaterThanOrEqual(1)
  })

  it("calls reset when reset clicked", () => {
    settings = {
      searchUsageStats: {
        tavily: {
          searchCount: 5,
          totalResponseTime: 500,
          errorCount: 0,
          lastUsedAt: null,
        },
      },
    }
    render(<SearchUsagePanel />)
    fireEvent.click(screen.getByText("reset"))
    expect(resetMock).toHaveBeenCalled()
  })

  it("logs usage_stats_reset with totals captured before reset", () => {
    settings = {
      searchUsageStats: {
        tavily: {
          searchCount: 5,
          totalResponseTime: 500,
          errorCount: 2,
          lastUsedAt: null,
        },
        brave: {
          searchCount: 3,
          totalResponseTime: 100,
          errorCount: 1,
          lastUsedAt: null,
        },
      },
    }
    render(<SearchUsagePanel />)
    fireEvent.click(screen.getByText("reset"))
    expect(mockLogInfo).toHaveBeenCalledWith("usage_stats_reset", {
      totalSearches: 8,
      totalErrors: 3,
    })
  })
})
