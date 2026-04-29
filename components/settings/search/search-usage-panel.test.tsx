import { render, screen, fireEvent } from "@testing-library/react"

const resetMock = jest.fn()
let settings: { searchUsageStats?: Record<string, unknown> } = {}

jest.mock("@/stores/settings-store", () => ({
  useSettingsStore: <T,>(
    selector: (s: { settings: typeof settings; resetSearchUsageStats: typeof resetMock }) => T
  ) => selector({ settings, resetSearchUsageStats: resetMock }),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { SearchUsagePanel } from "./search-usage-panel"

beforeEach(() => {
  resetMock.mockReset()
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
})
