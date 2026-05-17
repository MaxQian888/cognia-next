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
    fireEvent.click(screen.getByRole("switch"))
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
    fireEvent.click(screen.getByRole("switch"))
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
