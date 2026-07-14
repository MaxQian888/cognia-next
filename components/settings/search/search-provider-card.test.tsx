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
} = {
  providerId: "tavily",
  apiKey: "",
  enabled: false,
  priority: 1,
}

jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T,>(
    selector: (s: { settings: { searchProviders: Record<string, typeof providerSettings> } }) => T
  ) =>
    selector({
      settings: {
        searchProviders: { [providerSettings.providerId]: providerSettings },
      },
      ...mocks,
    } as never),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// Native <select> stub so the pool's rotation-strategy picker is interactable.
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
      data-testid="strategy-select"
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

  it("shows google cx field for google provider", () => {
    providerSettings = {
      providerId: "google",
      apiKey: "key",
      enabled: false,
      priority: 1,
    }
    renderCard({ providerId: "google" })
    expect(screen.getAllByText(/googleCx/i).length).toBeGreaterThan(0)
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
    fireEvent.change(screen.getByTestId("strategy-select"), { target: { value: "least-used" } })
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
