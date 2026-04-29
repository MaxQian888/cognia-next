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

jest.mock("@/stores/settings-store", () => ({
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

jest.mock("@/components/ui/collapsible", () => ({
  Collapsible: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CollapsibleTrigger: ({
    children,
    onClick,
  }: {
    children: React.ReactNode
    onClick?: () => void
  }) => <div onClick={onClick}>{children}</div>,
  CollapsibleContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

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
