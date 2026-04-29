import { render, screen, fireEvent, waitFor } from "@testing-library/react"

const searchMock = jest.fn()
let settings: { searchProviders?: Record<string, unknown> } = {}

jest.mock("@/lib/search/search-service", () => ({
  search: (...args: unknown[]) => searchMock(...args),
}))

jest.mock("@/stores/settings-store", () => ({
  useSettingsStore: <T,>(selector: (s: { settings: typeof settings }) => T) =>
    selector({ settings }),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
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
  searchMock.mockReset()
  settings = {
    searchProviders: {
      tavily: { providerId: "tavily", apiKey: "k", enabled: true, priority: 1 },
      brave: { providerId: "brave", apiKey: "k", enabled: true, priority: 2 },
    },
  }
})

describe("SearchProviderCompare", () => {
  it("renders title", () => {
    render(<SearchProviderCompare />)
    expect(screen.getByText("title")).toBeInTheDocument()
  })

  it("compare button disabled with no query", () => {
    render(<SearchProviderCompare />)
    expect(screen.getByText("compare")).toBeDisabled()
  })

  it("triggers parallel searches on compare", async () => {
    searchMock
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
    await waitFor(() => expect(searchMock).toHaveBeenCalledTimes(2))
  })

  it("displays error on search failure", async () => {
    searchMock.mockRejectedValueOnce(new Error("network"))
    render(<SearchProviderCompare />)
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "q" } })
    fireEvent.click(screen.getByText("compare"))
    await waitFor(() => expect(screen.getByText(/network/)).toBeInTheDocument())
  })
})
