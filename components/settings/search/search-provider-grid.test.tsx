import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { testProviderKeyPool } from "@cognia/web-search/provider-test"

const mocks = {
  setSearchProviderEnabled: jest.fn(),
}

let settings: { searchProviders?: Record<string, unknown> } = {}

jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T,>(selector: (s: Record<string, unknown>) => T) =>
    selector({ settings, ...mocks }),
}))

jest.mock("@cognia/web-search/provider-test", () => ({
  testProviderKeyPool: jest.fn(),
}))

jest.mock("./search-provider-card", () => ({
  SearchProviderCard: ({
    providerId,
    onTestConnection,
    onToggleExpand,
    onToggleKey,
  }: {
    providerId: string
    onTestConnection: () => void
    onToggleExpand: () => void
    onToggleKey: () => void
  }) => (
    <div data-testid={`card-${providerId}`}>
      <button onClick={onTestConnection}>{`test-${providerId}`}</button>
      <button onClick={onToggleExpand}>{`expand-${providerId}`}</button>
      <button onClick={onToggleKey}>{`key-${providerId}`}</button>
    </div>
  ),
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

jest.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuCheckboxItem: ({
    children,
    checked,
    onCheckedChange,
  }: {
    children: React.ReactNode
    checked?: boolean
    onCheckedChange?: (v: boolean) => void
  }) => <button onClick={() => onCheckedChange?.(!checked)}>{children}</button>,
}))

import { SearchProviderGrid } from "./search-provider-grid"

beforeEach(() => {
  Object.values(mocks).forEach((m) => m.mockReset())
  mockLogInfo.mockReset()
  settings = {
    searchProviders: {
      tavily: { providerId: "tavily", apiKey: "k", enabled: true, priority: 1 },
      brave: { providerId: "brave", apiKey: "", enabled: false, priority: 2 },
    },
  }
})

describe("SearchProviderGrid", () => {
  it("renders the providers toolbar", () => {
    render(<SearchProviderGrid />)
    expect(screen.getByPlaceholderText("filterProviders")).toBeInTheDocument()
  })

  it("filters providers via search query", () => {
    render(<SearchProviderGrid />)
    const searchInput = screen.getByPlaceholderText("filterProviders")
    fireEvent.change(searchInput, { target: { value: "tavily" } })
    expect(screen.getByTestId("card-tavily")).toBeInTheDocument()
    expect(screen.queryByTestId("card-brave")).not.toBeInTheDocument()
  })

  it("renders all 10 cards by default", () => {
    render(<SearchProviderGrid />)
    expect(screen.getAllByTestId(/card-/)).toHaveLength(10)
  })

  it("shows noMatchingProviders message when none match", () => {
    render(<SearchProviderGrid />)
    fireEvent.change(screen.getByPlaceholderText("filterProviders"), {
      target: { value: "nonexistent" },
    })
    expect(screen.getByText("noMatchingProviders")).toBeInTheDocument()
  })

  it("logs provider_reset_to_defaults when reset clicked", () => {
    render(<SearchProviderGrid />)
    fireEvent.click(screen.getByText("reset"))
    expect(mockLogInfo).toHaveBeenCalledWith("provider_reset_to_defaults")
  })

  it("enables all configured providers", () => {
    render(<SearchProviderGrid />)
    fireEvent.click(screen.getByText("enableAll"))
    expect(mocks.setSearchProviderEnabled).toHaveBeenCalledWith("tavily", true)
    // brave has no key → not configured → not enabled
    expect(mocks.setSearchProviderEnabled).not.toHaveBeenCalledWith("brave", true)
  })

  it("disables all filtered providers", () => {
    render(<SearchProviderGrid />)
    fireEvent.click(screen.getByText("disableAll"))
    expect(mocks.setSearchProviderEnabled).toHaveBeenCalledWith("tavily", false)
  })

  it("narrows the list via a feature filter", () => {
    render(<SearchProviderGrid />)
    fireEvent.click(screen.getByText("features.aiAnswer"))
    // Tavily advertises an AI answer; at least its card survives the filter.
    expect(screen.getByTestId("card-tavily")).toBeInTheDocument()
  })

  it("tests the whole key pool and reports on the primary", async () => {
    ;(testProviderKeyPool as jest.Mock).mockResolvedValueOnce([
      { index: 0, ok: true, keyHint: "k" },
    ])
    render(<SearchProviderGrid />)
    fireEvent.click(screen.getByText("test-tavily"))
    await waitFor(() =>
      expect(testProviderKeyPool).toHaveBeenCalledWith(
        "tavily",
        expect.objectContaining({ providerId: "tavily", apiKey: "k" })
      )
    )
    expect(mockLogInfo).toHaveBeenCalledWith(
      "provider_test_succeeded",
      expect.objectContaining({ providerId: "tavily", keys: 1, failedKeys: 0 })
    )
  })

  it("marks the test failed when the primary key fails even if backups pass", async () => {
    ;(testProviderKeyPool as jest.Mock).mockResolvedValueOnce([
      { index: 0, ok: false, keyHint: "k" },
      { index: 1, ok: true, keyHint: "k2" },
    ])
    render(<SearchProviderGrid />)
    fireEvent.click(screen.getByText("test-tavily"))
    await waitFor(() =>
      expect(mockLogInfo).toHaveBeenCalledWith(
        "provider_test_failed",
        expect.objectContaining({ providerId: "tavily", keys: 2, failedKeys: 1 })
      )
    )
  })

  it("expand and key-visibility toggles do not throw", () => {
    render(<SearchProviderGrid />)
    fireEvent.click(screen.getByText("expand-tavily"))
    fireEvent.click(screen.getByText("key-tavily"))
    expect(screen.getByTestId("card-tavily")).toBeInTheDocument()
  })

  it("narrows the list via the added videoSearch feature filter", () => {
    render(<SearchProviderGrid />)
    fireEvent.click(screen.getByText("features.videos"))
    // Serper advertises videoSearch; tavily does not.
    expect(screen.getByTestId("card-serper")).toBeInTheDocument()
    expect(screen.queryByTestId("card-tavily")).not.toBeInTheDocument()
  })
})
