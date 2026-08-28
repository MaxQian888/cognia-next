import { render, screen, fireEvent } from "@testing-library/react"

const mocks = {
  setSearchEnabled: jest.fn(),
  setSearchMaxResults: jest.fn(),
  setSearchFallbackEnabled: jest.fn(),
  setSearchMaxRetries: jest.fn(),
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
  useTranslations: () => (key: string) =>
    ({
      "domainSources.wikipedia": "Wikipedia",
      "domainSources.arxiv": "arXiv",
      "domainSources.github": "GitHub",
      "domainSources.stackoverflow": "Stack Overflow",
    })[key] ?? key,
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

jest.mock("@/components/ui/slider", () => ({
  Slider: ({
    value,
    onValueChange,
    onValueCommit,
    disabled,
  }: {
    value: number[]
    onValueChange: (v: number[]) => void
    onValueCommit?: (v: number[]) => void
    disabled?: boolean
  }) => (
    <input
      role="slider"
      type="number"
      aria-valuenow={value?.[0] ?? 0}
      disabled={disabled}
      value={value?.[0] ?? 0}
      onChange={(e) => {
        onValueChange([Number(e.target.value)])
        onValueCommit?.([Number(e.target.value)])
      }}
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
  SelectGroup: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({
    value,
    disabled,
  }: {
    value: string
    children: React.ReactNode
    disabled?: boolean
  }) => (
    <option value={value} disabled={disabled}>
      {value}
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

// Shared stub: components/ui/__mocks__/collapsible.tsx
jest.mock("@/components/ui/collapsible")

import { SearchGlobalSettings } from "./search-global-settings"

beforeEach(() => {
  Object.values(mocks).forEach((m) => m.mockReset())
  mockLogInfo.mockReset()
  settings = {}
})

describe("SearchGlobalSettings", () => {
  it("renders the enable toggle", () => {
    render(<SearchGlobalSettings />)
    expect(screen.getByText("enableSearch")).toBeInTheDocument()
  })

  it("shows actionable guidance (not a disabled switch) when no providers configured", () => {
    settings = {}
    const onConfigureProviders = jest.fn()
    render(<SearchGlobalSettings onConfigureProviders={onConfigureProviders} />)
    // Guidance replaces the old cold-disabled enable switch.
    expect(screen.getByText("configureProviderHint")).toBeInTheDocument()
    expect(screen.getAllByRole("switch")[0]).not.toBeDisabled()
    fireEvent.click(screen.getByText("providers"))
    expect(onConfigureProviders).toHaveBeenCalled()
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

  it("keeps executor-wide settings writable when proactive pre-search is off", () => {
    settings = {
      searchEnabled: false,
      searchProviders: {
        tavily: { providerId: "tavily", apiKey: "k", enabled: true, priority: 1 },
      },
      defaultSearchSources: [],
    }
    render(<SearchGlobalSettings />)

    expect(screen.getAllByRole("switch")[1]).not.toBeDisabled()
    expect(screen.getByTestId("provider-select")).not.toBeDisabled()
    for (const slider of screen.getAllByRole("slider")) expect(slider).not.toBeDisabled()
    expect(screen.getByText("Wikipedia").closest("button")).not.toBeDisabled()
    expect(screen.getByText("addCustomSource").closest("button")).not.toBeDisabled()
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
    // slider[0] = maxResults, slider[1] = maxRetries
    fireEvent.change(screen.getAllByRole("slider")[0], { target: { value: 8 } })
    expect(mocks.setSearchMaxResults).toHaveBeenCalledWith(8)
  })

  it("changes maxRetries via the second slider", () => {
    settings = { searchEnabled: true }
    render(<SearchGlobalSettings />)
    fireEvent.change(screen.getAllByRole("slider")[1], { target: { value: 4 } })
    expect(mocks.setSearchMaxRetries).toHaveBeenCalledWith(4)
  })

  it("shows configured providers and explicit built-in domains", () => {
    settings = {
      searchEnabled: true,
      searchProviders: {
        tavily: { providerId: "tavily", apiKey: "k", enabled: true, priority: 1 },
      },
      defaultSearchSources: [],
    }
    render(<SearchGlobalSettings />)
    expect(screen.getByText("Tavily")).toBeInTheDocument()
    expect(screen.queryByText("Google")).not.toBeInTheDocument()
    expect(screen.getByText("Wikipedia")).toBeInTheDocument()
    expect(screen.getByText("wikipedia.org")).toBeInTheDocument()
  })

  it("toggles a configured provider source on click", () => {
    settings = {
      searchEnabled: true,
      searchProviders: {
        tavily: { providerId: "tavily", apiKey: "k", enabled: true, priority: 1 },
      },
      defaultSearchSources: [],
    }
    render(<SearchGlobalSettings />)
    fireEvent.click(screen.getByRole("button", { name: /Tavily/ }))
    expect(mocks.setDefaultSearchSources).toHaveBeenCalledWith(["tavily"])
  })

  it("adds a custom research source with a normalized domain", () => {
    settings = { searchEnabled: true }
    render(<SearchGlobalSettings />)
    fireEvent.change(screen.getByPlaceholderText("sourceNamePlaceholder"), {
      target: { value: "My Source" },
    })
    fireEvent.change(screen.getByPlaceholderText("sourceDomainPlaceholder"), {
      target: { value: "https://Docs.Example.com/path" },
    })
    fireEvent.click(screen.getByText("add"))
    expect(mocks.addCustomSearchSource).toHaveBeenCalledWith(
      expect.objectContaining({ name: "My Source", domain: "docs.example.com" })
    )
  })

  it("adds a custom research source via the Enter key", () => {
    settings = { searchEnabled: true }
    render(<SearchGlobalSettings />)
    const input = screen.getByPlaceholderText("sourceNamePlaceholder")
    fireEvent.change(input, { target: { value: "Enter Source" } })
    const domainInput = screen.getByPlaceholderText("sourceDomainPlaceholder")
    fireEvent.change(domainInput, { target: { value: "example.com" } })
    fireEvent.keyDown(domainInput, { key: "Enter" })
    expect(mocks.addCustomSearchSource).toHaveBeenCalled()
  })

  it("toggles a custom research source", () => {
    settings = {
      searchEnabled: true,
      customSearchSources: [{ id: "c1", name: "MySrc", domain: "my.example" }],
      defaultSearchSources: [],
    }
    render(<SearchGlobalSettings />)
    fireEvent.click(screen.getByText("MySrc").closest("button")!)
    expect(mocks.setDefaultSearchSources).toHaveBeenCalledWith(["c1"])
  })

  it("removes a selected custom research source", () => {
    settings = {
      searchEnabled: true,
      customSearchSources: [{ id: "c1", name: "MySrc", domain: "my.example" }],
      defaultSearchSources: ["c1"],
    }
    render(<SearchGlobalSettings />)
    fireEvent.click(screen.getByText("×"))
    expect(mocks.removeCustomSearchSource).toHaveBeenCalledWith("c1")
    expect(mocks.setDefaultSearchSources).toHaveBeenCalledWith([])
  })

  it("removes a selected domain source on click", () => {
    settings = {
      searchEnabled: true,
      defaultSearchSources: ["wikipedia"],
    }
    render(<SearchGlobalSettings />)
    fireEvent.click(screen.getByRole("button", { name: /Wikipedia/ }))
    expect(mocks.setDefaultSearchSources).toHaveBeenCalledWith([])
  })

  it("renders custom sources and removes them", () => {
    settings = {
      searchEnabled: true,
      defaultSearchSources: ["custom-1"],
      customSearchSources: [{ id: "custom-1", name: "MyDocs", domain: "docs.example" }],
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
    fireEvent.change(screen.getByPlaceholderText("sourceDomainPlaceholder"), {
      target: { value: "docs.example.com" },
    })
    fireEvent.click(screen.getByText("add"))
    expect(mocks.addCustomSearchSource).toHaveBeenCalledWith(
      expect.objectContaining({ name: "MyDocs", domain: "docs.example.com" })
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
    const domainInput = screen.getByPlaceholderText("sourceDomainPlaceholder")
    fireEvent.change(domainInput, { target: { value: "docs.example.com" } })
    fireEvent.keyDown(domainInput, { key: "Enter" })
    expect(mocks.addCustomSearchSource).toHaveBeenCalled()
  })

  it("logs source_toggled when a source pill is clicked", () => {
    settings = { searchEnabled: true, defaultSearchSources: [] }
    render(<SearchGlobalSettings />)
    fireEvent.click(screen.getByRole("button", { name: /Wikipedia/ }))
    expect(mockLogInfo).toHaveBeenCalledWith("source_toggled", {
      sourceId: "wikipedia",
      selected: true,
    })
  })

  it("rejects an invalid custom source domain", () => {
    settings = { searchEnabled: true }
    render(<SearchGlobalSettings />)
    fireEvent.change(screen.getByPlaceholderText("sourceNamePlaceholder"), {
      target: { value: "Broken" },
    })
    fireEvent.change(screen.getByPlaceholderText("sourceDomainPlaceholder"), {
      target: { value: "not a domain" },
    })
    fireEvent.click(screen.getByText("add"))
    expect(screen.getByText("invalidSourceDomain")).toHaveAttribute("role", "alert")
    expect(mocks.addCustomSearchSource).not.toHaveBeenCalled()
  })

  it("keeps legacy custom sources without a domain visible but disabled", () => {
    settings = {
      searchEnabled: true,
      customSearchSources: [{ id: "legacy", name: "Legacy source" }],
      defaultSearchSources: ["legacy"],
    }
    render(<SearchGlobalSettings />)
    expect(screen.getByText("Legacy source").closest("button")).toBeDisabled()
    expect(screen.getByText("sourceNeedsDomain")).toBeInTheDocument()
  })
})
