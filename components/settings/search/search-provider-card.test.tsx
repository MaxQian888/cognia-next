import { render, screen, fireEvent } from "@testing-library/react"
import { TooltipProvider } from "@/components/ui/tooltip"

const mocks = {
  setSearchProviderSettings: jest.fn(),
  setSearchProviderApiKey: jest.fn(),
  setSearchProviderEnabled: jest.fn(),
  setSearchProviderPriority: jest.fn(),
}

let providerSettings: {
  providerId: string
  apiKey: string
  enabled: boolean
  priority: number
  cx?: string
  apiKeys?: string[]
  apiKeyRotationEnabled?: boolean
  apiKeyRotationStrategy?: string
  defaultOptions?: { searchType?: string; searchDepth?: string; maxResults?: number }
} = {
  providerId: "tavily",
  apiKey: "",
  enabled: false,
  priority: 1,
}
let hasStoredProviderSettings = true

jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T,>(
    selector: (s: { settings: { searchProviders: Record<string, typeof providerSettings> } }) => T
  ) =>
    selector({
      settings: {
        searchProviders: hasStoredProviderSettings
          ? { [providerSettings.providerId]: providerSettings }
          : {},
      },
      ...mocks,
    } as never),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// Native <select> stub so the pool's rotation-strategy picker and the
// default-overrides editor are interactable. No testid — several selects can
// be on the card at once; locate them via their label instead.
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
    <select
      value={value}
      onChange={(e) => onValueChange?.(e.target.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <option value={value}>{children}</option>
  ),
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

// Shared stub: components/ui/__mocks__/collapsible.tsx (production uses asChild)
jest.mock("@/components/ui/collapsible")

import { SearchProviderCard } from "./search-provider-card"

function renderCard(props: Partial<React.ComponentProps<typeof SearchProviderCard>> = {}) {
  return render(
    <TooltipProvider>
      <SearchProviderCard
        providerId="tavily"
        isExpanded={true}
        showKey={false}
        testState={{ testing: false, result: null }}
        onToggleExpand={jest.fn()}
        onToggleKey={jest.fn()}
        onTestConnection={jest.fn()}
        {...props}
      />
    </TooltipProvider>
  )
}

beforeEach(() => {
  Object.values(mocks).forEach((m) => m.mockReset())
  mockLogInfo.mockReset()
  hasStoredProviderSettings = true
  providerSettings = {
    providerId: "tavily",
    apiKey: "",
    enabled: false,
    priority: 5,
  }
})

describe("SearchProviderCard", () => {
  it("renders provider name", () => {
    renderCard()
    expect(screen.getAllByText("Tavily").length).toBeGreaterThan(0)
  })

  it("renders the provider brand icon", () => {
    renderCard()

    expect(document.querySelector('img[src="/icons/lobe/tavily-color.svg"]')).not.toBeNull()
  })

  it("renders a collapsed provider with its default settings", () => {
    hasStoredProviderSettings = false
    const { container } = renderCard({ isExpanded: false })

    expect(container.querySelector(".opacity-70")).not.toBeNull()
    expect(container.querySelector(".lucide-chevron-down")).not.toBeNull()
  })

  it("reveals the key and shows the busy connection state", () => {
    providerSettings = {
      providerId: "tavily",
      apiKey: "tvly-1234567890abc",
      enabled: true,
      priority: 5,
    }
    const { container } = renderCard({
      showKey: true,
      testState: { testing: true, result: null },
    })

    expect(screen.getAllByPlaceholderText(/tvly-/)[0]).toHaveAttribute("type", "text")
    expect(container.querySelector(".lucide-eye-off")).not.toBeNull()
    expect(container.querySelector(".lucide-loader-circle")).not.toBeNull()
  })

  it("updates API key on input change", () => {
    renderCard()
    const input = screen.getByPlaceholderText(/tvly-/)
    fireEvent.change(input, { target: { value: "tvly-1234567890abc" } })
    expect(mocks.setSearchProviderApiKey).toHaveBeenCalledWith("tavily", "tvly-1234567890abc")
  })

  it("toggles enabled when switch clicked", () => {
    providerSettings = {
      providerId: "tavily",
      apiKey: "tvly-1234567890abc",
      enabled: false,
      priority: 1,
    }
    renderCard()
    // switch[0] = the provider enable toggle (switch[1] is the key-rotation toggle)
    fireEvent.click(screen.getAllByRole("switch")[0])
    expect(mocks.setSearchProviderEnabled).toHaveBeenCalledWith("tavily", true)
  })

  it("calls onTestConnection when test button clicked", () => {
    providerSettings = {
      providerId: "tavily",
      apiKey: "tvly-1234567890abc",
      enabled: false,
      priority: 1,
    }
    const onTest = jest.fn()
    renderCard({ onTestConnection: onTest })
    fireEvent.click(screen.getByText("testConnection"))
    expect(onTest).toHaveBeenCalled()
  })

  it("shows google cx field for google provider and enables the toggle once cx is set", () => {
    providerSettings = {
      providerId: "google",
      apiKey: "key",
      enabled: false,
      priority: 1,
      cx: "abc:123",
    }
    renderCard({ providerId: "google" })
    expect(screen.getAllByText(/googleCx/i).length).toBeGreaterThan(0)
    expect(screen.getAllByRole("switch")[0]).not.toBeDisabled()
  })

  it("logs provider_enabled_changed when switch toggled", () => {
    providerSettings = {
      providerId: "tavily",
      apiKey: "tvly-1234567890abc",
      enabled: false,
      priority: 1,
    }
    renderCard()
    fireEvent.click(screen.getAllByRole("switch")[0])
    expect(mockLogInfo).toHaveBeenCalledWith("provider_enabled_changed", {
      providerId: "tavily",
      enabled: true,
    })
  })

  it("logs provider_api_key_changed on input blur with hasKey shape only", () => {
    renderCard()
    const input = screen.getByPlaceholderText(/tvly-/)
    fireEvent.change(input, { target: { value: "tvly-1234567890abc" } })
    fireEvent.blur(input, { target: { value: "tvly-1234567890abc" } })
    expect(mockLogInfo).toHaveBeenCalledWith(
      "provider_api_key_changed",
      expect.objectContaining({ providerId: "tavily", hasKey: true })
    )
    const calls = mockLogInfo.mock.calls.filter(([n]) => n === "provider_api_key_changed")
    expect(calls.length).toBeGreaterThan(0)
    const [, ctx] = calls[calls.length - 1]
    expect((ctx as Record<string, unknown>).apiKey).toBeUndefined()
    expect(JSON.stringify(ctx)).not.toContain("tvly-1234567890abc")
  })

  it("toggles key rotation via the pool switch", () => {
    providerSettings = {
      providerId: "tavily",
      apiKey: "tvly-1234567890abc",
      enabled: true,
      priority: 1,
    }
    renderCard()
    // switch[1] is the key-rotation toggle inside the pool
    fireEvent.click(screen.getAllByRole("switch")[1])
    expect(mocks.setSearchProviderSettings).toHaveBeenCalledWith("tavily", {
      apiKeyRotationEnabled: true,
    })
  })

  it("adds a backup key through the pool", () => {
    providerSettings = {
      providerId: "tavily",
      apiKey: "tvly-1234567890abc",
      enabled: true,
      priority: 1,
    }
    renderCard()
    const inputs = screen.getAllByPlaceholderText(/tvly-/)
    // last input is the pool's draft field (first is the primary key)
    fireEvent.change(inputs[inputs.length - 1], { target: { value: "tvly-backup999" } })
    fireEvent.click(screen.getByText("addBackupKey"))
    expect(mocks.setSearchProviderSettings).toHaveBeenCalledWith("tavily", {
      apiKeys: ["tvly-backup999"],
    })
  })

  it("changes the rotation strategy through the pool", () => {
    providerSettings = {
      providerId: "tavily",
      apiKey: "tvly-1234567890abc",
      enabled: true,
      priority: 1,
      apiKeyRotationEnabled: true,
      apiKeyRotationStrategy: "round-robin",
    }
    renderCard()
    const strategySelect = screen
      .getByText("rotationStrategy")
      .parentElement!.querySelector("select")!
    fireEvent.change(strategySelect, { target: { value: "least-used" } })
    expect(mocks.setSearchProviderSettings).toHaveBeenCalledWith("tavily", {
      apiKeyRotationStrategy: "least-used",
    })
  })

  it("does not show the rotation pool until a primary key exists", () => {
    providerSettings = { providerId: "tavily", apiKey: "", enabled: false, priority: 1 }
    renderCard()
    expect(screen.queryByText("rotateKeys")).not.toBeInTheDocument()
  })

  it("updates the google cx field and logs on blur", () => {
    providerSettings = {
      providerId: "google",
      apiKey: "AIzakey123456",
      enabled: false,
      priority: 1,
    }
    renderCard({ providerId: "google" })
    const cx = screen.getByPlaceholderText("googleCxPlaceholder")
    fireEvent.change(cx, { target: { value: "abc:123" } })
    expect(mocks.setSearchProviderSettings).toHaveBeenCalledWith("google", { cx: "abc:123" })
    fireEvent.blur(cx, { target: { value: "abc:123" } })
    expect(mockLogInfo).toHaveBeenCalledWith("provider_cx_changed", {
      providerId: "google",
      hasCx: true,
    })
  })

  it("renders per-key results when the pool test reports multiple keys", () => {
    providerSettings = {
      providerId: "tavily",
      apiKey: "tvly-1234567890abc",
      enabled: true,
      priority: 1,
    }
    renderCard({
      testState: {
        testing: false,
        result: "success",
        keyResults: [
          { index: 0, ok: true, keyHint: "0abc" },
          { index: 1, ok: false, keyHint: "9999" },
        ],
      },
    })
    expect(screen.getByText("keyPoolResults")).toBeInTheDocument()
    expect(screen.getByText("keyPrimary")).toBeInTheDocument()
    expect(screen.getByText("keyBackup")).toBeInTheDocument()
    expect(screen.getByText("…9999")).toBeInTheDocument()
  })

  it("hides the per-key list for a single-key result", () => {
    providerSettings = {
      providerId: "tavily",
      apiKey: "tvly-1234567890abc",
      enabled: true,
      priority: 1,
    }
    renderCard({
      testState: {
        testing: false,
        result: "success",
        keyResults: [{ index: 0, ok: true, keyHint: "0abc" }],
      },
    })
    expect(screen.queryByText("keyPoolResults")).not.toBeInTheDocument()
  })

  it("shows the default-overrides editor with an active count badge", () => {
    providerSettings = {
      providerId: "tavily",
      apiKey: "tvly-1234567890abc",
      enabled: true,
      priority: 1,
      defaultOptions: { searchType: "news", maxResults: 10 },
    }
    renderCard()
    expect(screen.getByText("overrides.title")).toBeInTheDocument()
    expect(screen.getByText("overrides.count")).toBeInTheDocument()
  })

  it("shows video and country badges for providers that support them", () => {
    providerSettings = {
      providerId: "serper",
      apiKey: "serper-key",
      enabled: true,
      priority: 1,
    }
    renderCard({ providerId: "serper" })
    expect(screen.getByText("features.videos")).toBeInTheDocument()
    expect(screen.getByText("features.countryFilter")).toBeInTheDocument()
  })

  it("logs an empty key list when the last override reverts to inherit", () => {
    providerSettings = {
      providerId: "tavily",
      apiKey: "tvly-1234567890abc",
      enabled: true,
      priority: 1,
      defaultOptions: { searchType: "news" },
    }
    renderCard()
    const select = screen.getByText("searchType").parentElement!.querySelector("select")!
    fireEvent.change(select, { target: { value: "__inherit__" } })
    expect(mocks.setSearchProviderSettings).toHaveBeenCalledWith("tavily", {
      defaultOptions: undefined,
    })
    expect(mockLogInfo).toHaveBeenCalledWith("provider_overrides_changed", {
      providerId: "tavily",
      keys: [],
    })
  })

  it("falls back to P5 when the stored row has no priority", () => {
    providerSettings = {
      providerId: "tavily",
      apiKey: "tvly-1234567890abc",
      enabled: true,
    } as typeof providerSettings
    renderCard()
    expect(screen.getByText("priority: P5")).toBeInTheDocument()
  })

  it("logs hasKey=false when the api key field blurs empty", () => {
    renderCard()
    const input = screen.getByPlaceholderText(/tvly-/)
    fireEvent.blur(input, { target: { value: "" } })
    expect(mockLogInfo).toHaveBeenCalledWith(
      "provider_api_key_changed",
      expect.objectContaining({ providerId: "tavily", hasKey: false, valid: false })
    )
  })

  it("persists a defaultOptions override and logs the changed keys", () => {
    providerSettings = {
      providerId: "tavily",
      apiKey: "tvly-1234567890abc",
      enabled: true,
      priority: 1,
    }
    renderCard()
    // The editor's selects are plain <select> stubs; searchType is the first.
    const label = screen.getByText("searchType")
    const select = label.parentElement!.querySelector("select")!
    fireEvent.change(select, { target: { value: "news" } })
    expect(mocks.setSearchProviderSettings).toHaveBeenCalledWith("tavily", {
      defaultOptions: { searchType: "news" },
    })
    expect(mockLogInfo).toHaveBeenCalledWith("provider_overrides_changed", {
      providerId: "tavily",
      keys: ["searchType"],
    })
  })

  it("adjusts priority up and down", () => {
    providerSettings = {
      providerId: "tavily",
      apiKey: "tvly-1234567890abc",
      enabled: true,
      priority: 5,
    }
    renderCard()
    const buttons = screen.getAllByRole("button")
    const up = buttons.find((b) => b.querySelector("svg")?.classList.contains("lucide-arrow-up"))
    const down = buttons.find((b) =>
      b.querySelector("svg")?.classList.contains("lucide-arrow-down")
    )
    if (up) {
      fireEvent.click(up)
      expect(mocks.setSearchProviderPriority).toHaveBeenCalledWith("tavily", 4)
    }
    if (down) {
      fireEvent.click(down)
      expect(mocks.setSearchProviderPriority).toHaveBeenCalledWith("tavily", 6)
    }
  })
})
