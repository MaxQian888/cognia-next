import { render, screen, fireEvent, waitFor } from "@testing-library/react"

const searchWithAppSettingsMock = jest.fn()
let settings: { searchProviders?: Record<string, unknown>; searchSafeSearchLevel?: string } = {}

jest.mock("@/lib/search/configured-search", () => ({
  searchWithAppSettings: (...args: unknown[]) => searchWithAppSettingsMock(...args),
}))

jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T,>(selector: (s: { settings: typeof settings }) => T) =>
    selector({ settings }),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const mockLogInfo = jest.fn()
const mockLogError = jest.fn()
jest.mock("@cognia/logging", () => ({
  createLogger: () => ({
    info: (...args: unknown[]) => mockLogInfo(...args),
    error: (...args: unknown[]) => mockLogError(...args),
    warn: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
    fatal: jest.fn(),
  }),
}))

jest.mock("@/components/ui/select", () => ({
  Select: ({
    children,
    value,
    onValueChange,
  }: {
    children: React.ReactNode
    value?: string
    onValueChange?: (v: string) => void
  }) => (
    <select data-testid="select" value={value} onChange={(e) => onValueChange?.(e.target.value)}>
      {children}
    </select>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  ),
  SelectValue: () => null,
}))

import { SearchProviderCompare } from "./search-provider-compare"

beforeEach(() => {
  searchWithAppSettingsMock.mockReset()
  mockLogInfo.mockReset()
  mockLogError.mockReset()
  settings = {
    searchProviders: {
      tavily: { providerId: "tavily", apiKey: "k", enabled: true, priority: 1 },
      brave: { providerId: "brave", apiKey: "k", enabled: true, priority: 2 },
    },
  }
})

describe("SearchProviderCompare", () => {
  it("renders the query label", () => {
    render(<SearchProviderCompare />)
    expect(screen.getByText("query")).toBeInTheDocument()
  })

  it("compare button disabled with no query", () => {
    render(<SearchProviderCompare />)
    expect(screen.getByText("compare")).toBeDisabled()
  })

  it("triggers parallel searches on compare", async () => {
    searchWithAppSettingsMock
      .mockResolvedValueOnce({
        provider: "tavily",
        query: "q",
        results: [],
        responseTime: 10,
      })
      .mockResolvedValueOnce({
        provider: "brave",
        query: "q",
        results: [],
        responseTime: 12,
      })
    render(<SearchProviderCompare />)
    const input = screen.getByRole("textbox")
    fireEvent.change(input, { target: { value: "react" } })
    fireEvent.click(screen.getByText("compare"))
    await waitFor(() => expect(searchWithAppSettingsMock).toHaveBeenCalledTimes(2))
    expect(searchWithAppSettingsMock).toHaveBeenNthCalledWith(
      1,
      "react",
      expect.objectContaining({
        settings,
        useCache: false,
        options: {
          provider: "tavily",
          preferredProviders: ["tavily"],
          fallbackEnabled: false,
        },
      })
    )
  })

  it("renders result columns with parsed hostnames and a noResult column", async () => {
    searchWithAppSettingsMock
      .mockResolvedValueOnce({
        provider: "tavily",
        query: "q",
        results: [
          { title: "Good", content: "c", url: "https://example.com/path" },
          { title: "Bad", content: "c", url: "::not-a-url::" },
        ],
        responseTime: 10,
      })
      .mockResolvedValueOnce({ provider: "brave", query: "q", results: [], responseTime: 5 })
    render(<SearchProviderCompare />)
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "react" } })
    fireEvent.click(screen.getByText("compare"))
    await waitFor(() => expect(screen.getByText("Good")).toBeInTheDocument())
    // Valid URL → hostname; invalid URL → raw string fallback.
    expect(screen.getByText("example.com")).toBeInTheDocument()
    expect(screen.getByText("::not-a-url::")).toBeInTheDocument()
  })

  it("displays error on search failure", async () => {
    searchWithAppSettingsMock.mockRejectedValueOnce(new Error("network"))
    render(<SearchProviderCompare />)
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "q" } })
    fireEvent.click(screen.getByText("compare"))
    await waitFor(() => expect(screen.getByText(/network/)).toBeInTheDocument())
  })

  it("logs compare_started with queryLen only (no raw query)", async () => {
    searchWithAppSettingsMock
      .mockResolvedValueOnce({ provider: "tavily", query: "q", results: [], responseTime: 1 })
      .mockResolvedValueOnce({ provider: "brave", query: "q", results: [], responseTime: 1 })
    render(<SearchProviderCompare />)
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "secret-query" } })
    fireEvent.click(screen.getByText("compare"))
    await waitFor(() => expect(searchWithAppSettingsMock).toHaveBeenCalled())
    expect(mockLogInfo).toHaveBeenCalledWith(
      "compare_started",
      expect.objectContaining({ queryLen: "secret-query".length })
    )
    const allArgs = JSON.stringify(mockLogInfo.mock.calls)
    expect(allArgs).not.toContain("secret-query")
  })

  it("logs compare_failed via log.error on rejection", async () => {
    const err = new Error("boom")
    searchWithAppSettingsMock.mockRejectedValueOnce(err)
    render(<SearchProviderCompare />)
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "q" } })
    fireEvent.click(screen.getByText("compare"))
    await waitFor(() => expect(mockLogError).toHaveBeenCalled())
    expect(mockLogError).toHaveBeenCalledWith(
      "compare_failed",
      err,
      expect.objectContaining({ providerA: "tavily", providerB: "brave" })
    )
  })
})
