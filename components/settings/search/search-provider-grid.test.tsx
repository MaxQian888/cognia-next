import { render, screen, fireEvent } from "@testing-library/react"

const mocks = {
  setSearchProviderEnabled: jest.fn(),
}

let settings: { searchProviders?: Record<string, unknown> } = {}

jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T,>(selector: (s: Record<string, unknown>) => T) =>
    selector({ settings, ...mocks }),
}))

jest.mock("@/lib/search/provider-test", () => ({
  testProviderConnection: jest.fn(),
}))

jest.mock("./search-provider-card", () => ({
  SearchProviderCard: ({ providerId }: { providerId: string }) => (
    <div data-testid={`card-${providerId}`} />
  ),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const mockLogInfo = jest.fn()
jest.mock("@/lib/logger", () => ({
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
  it("renders providers section", () => {
    render(<SearchProviderGrid />)
    expect(screen.getByText("providers")).toBeInTheDocument()
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
})
