import { render, screen, fireEvent } from "@testing-library/react"

const mocks = {
  setSearchEnabled: jest.fn(),
  setSearchMaxResults: jest.fn(),
  setSearchFallbackEnabled: jest.fn(),
  setDefaultSearchProvider: jest.fn(),
  setDefaultSearchSources: jest.fn(),
  addCustomSearchSource: jest.fn(),
  removeCustomSearchSource: jest.fn(),
}

let settings: Record<string, unknown> = {}

jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T,>(selector: (s: Record<string, unknown>) => T) =>
    selector({ settings, ...mocks }),
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

jest.mock("@/components/ui/slider", () => ({
  Slider: ({
    value,
    onValueChange,
    disabled,
  }: {
    value: number[]
    onValueChange: (v: number[]) => void
    disabled?: boolean
  }) => (
    <input
      role="slider"
      type="number"
      aria-valuenow={value?.[0] ?? 0}
      disabled={disabled}
      value={value?.[0] ?? 0}
      onChange={(e) => onValueChange([Number(e.target.value)])}
    />
  ),
}))

jest.mock("@/components/ui/select", () => ({
  Select: ({
    children,
    value,
    onValueChange,
    disabled,
  }: {
    children: React.ReactNode
    value?: string
    onValueChange?: (v: string) => void
    disabled?: boolean
  }) => (
    <select
      data-testid="provider-select"
      value={value}
      disabled={disabled}
      onChange={(e) => onValueChange?.(e.target.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({
    value,
    children,
    disabled,
  }: {
    value: string
    children: React.ReactNode
    disabled?: boolean
  }) => (
    <option value={value} disabled={disabled}>
      {children}
    </option>
  ),
  SelectValue: () => null,
}))

jest.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open?: boolean }) => (
    <div data-testid="dialog" data-open={open}>
      {children}
    </div>
  ),
  DialogTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

jest.mock("@/components/ui/collapsible", () => ({
  Collapsible: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CollapsibleTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  CollapsibleContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

import { SearchGlobalSettings } from "./search-global-settings"

beforeEach(() => {
  Object.values(mocks).forEach((m) => m.mockReset())
  mockLogInfo.mockReset()
  settings = {}
})

describe("SearchGlobalSettings", () => {
  it("renders title", () => {
    render(<SearchGlobalSettings />)
    expect(screen.getByText("title")).toBeInTheDocument()
  })

  it("disables enable switch when no providers configured", () => {
    settings = {}
    render(<SearchGlobalSettings />)
    const enableSwitch = screen.getAllByRole("switch")[0]
    expect(enableSwitch).toBeDisabled()
  })

  it("toggles search enabled", () => {
    settings = {
      searchProviders: {
        tavily: { providerId: "tavily", apiKey: "k", enabled: true, priority: 1 },
      },
    }
    render(<SearchGlobalSettings />)
    const enableSwitch = screen.getAllByRole("switch")[0]
    fireEvent.click(enableSwitch)
    expect(mocks.setSearchEnabled).toHaveBeenCalledWith(true)
  })

  it("toggles fallback enabled", () => {
    settings = {
      searchEnabled: true,
      searchProviders: {
        tavily: { providerId: "tavily", apiKey: "k", enabled: true, priority: 1 },
      },
    }
    render(<SearchGlobalSettings />)
    const switches = screen.getAllByRole("switch")
    fireEvent.click(switches[1])
    expect(mocks.setSearchFallbackEnabled).toHaveBeenCalled()
  })

  it("changes default provider", () => {
    settings = {
      searchEnabled: true,
      searchProviders: {
        tavily: { providerId: "tavily", apiKey: "k", enabled: true, priority: 1 },
        perplexity: { providerId: "perplexity", apiKey: "k", enabled: true, priority: 2 },
      },
    }
    render(<SearchGlobalSettings />)
    fireEvent.change(screen.getByTestId("provider-select"), {
      target: { value: "perplexity" },
    })
    expect(mocks.setDefaultSearchProvider).toHaveBeenCalledWith("perplexity")
  })

  it("changes maxResults via slider", () => {
    settings = {
      searchEnabled: true,
      searchProviders: {
        tavily: { providerId: "tavily", apiKey: "k", enabled: true, priority: 1 },
      },
    }
    render(<SearchGlobalSettings />)
    fireEvent.change(screen.getByRole("slider"), { target: { value: 8 } })
    expect(mocks.setSearchMaxResults).toHaveBeenCalledWith(8)
  })

  it("toggles a search source on click", () => {
    settings = {
      searchEnabled: true,
      defaultSearchSources: [],
    }
    render(<SearchGlobalSettings />)
    fireEvent.click(screen.getByText("Google"))
    expect(mocks.setDefaultSearchSources).toHaveBeenCalledWith(["google"])
  })

  it("removes a selected source on click", () => {
    settings = {
      searchEnabled: true,
      defaultSearchSources: ["google"],
    }
    render(<SearchGlobalSettings />)
    fireEvent.click(screen.getByText("Google"))
    expect(mocks.setDefaultSearchSources).toHaveBeenCalledWith([])
  })

  it("renders custom sources and removes them", () => {
    settings = {
      searchEnabled: true,
      defaultSearchSources: ["custom-1"],
      customSearchSources: [{ id: "custom-1", name: "MyDocs" }],
    }
    render(<SearchGlobalSettings />)
    expect(screen.getByText("MyDocs")).toBeInTheDocument()
    fireEvent.click(screen.getByText("×"))
    expect(mocks.removeCustomSearchSource).toHaveBeenCalledWith("custom-1")
  })

  it("adds custom source from dialog input", () => {
    settings = { searchEnabled: true }
    render(<SearchGlobalSettings />)
    const dialogInput = screen.getByPlaceholderText("sourceNamePlaceholder")
    fireEvent.change(dialogInput, { target: { value: "MyDocs" } })
    fireEvent.click(screen.getByText("add"))
    expect(mocks.addCustomSearchSource).toHaveBeenCalledWith(
      expect.objectContaining({ name: "MyDocs" })
    )
  })

  it("ignores empty custom source name", () => {
    settings = { searchEnabled: true }
    render(<SearchGlobalSettings />)
    fireEvent.click(screen.getByText("add"))
    expect(mocks.addCustomSearchSource).not.toHaveBeenCalled()
  })

  it("submits custom source on Enter key", () => {
    settings = { searchEnabled: true }
    render(<SearchGlobalSettings />)
    const dialogInput = screen.getByPlaceholderText("sourceNamePlaceholder")
    fireEvent.change(dialogInput, { target: { value: "MyDocs" } })
    fireEvent.keyDown(dialogInput, { key: "Enter" })
    expect(mocks.addCustomSearchSource).toHaveBeenCalled()
  })

  it("logs source_toggled when a source pill is clicked", () => {
    settings = { searchEnabled: true, defaultSearchSources: [] }
    render(<SearchGlobalSettings />)
    fireEvent.click(screen.getByText("Google"))
    expect(mockLogInfo).toHaveBeenCalledWith("source_toggled", {
      sourceId: "google",
      selected: true,
    })
  })
})
