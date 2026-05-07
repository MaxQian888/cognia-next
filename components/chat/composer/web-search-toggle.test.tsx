import { render, screen, fireEvent } from "@testing-library/react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { WebSearchToggle } from "./web-search-toggle"

function renderWithTooltip(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>)
}

const setOnMock = jest.fn()

let chatState: {
  webSearchOnForNextSend: boolean
  setWebSearchOnForNextSend: (v: boolean) => void
} = {
  webSearchOnForNextSend: false,
  setWebSearchOnForNextSend: setOnMock,
}
let settingsState: {
  searchEnabled?: boolean
  searchProviders?: Record<
    string,
    { providerId: string; apiKey: string; enabled: boolean; priority: number; cx?: string }
  >
  defaultSearchProvider?: string
} = {}

jest.mock("@/stores/chat", () => ({
  useChatStore: <T,>(selector: (s: typeof chatState) => T) => selector(chatState),
}))

jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T,>(selector: (s: { settings: typeof settingsState }) => T) =>
    selector({ settings: settingsState }),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, string | number>) => {
    if (vars?.provider) return `${key}-${vars.provider}`
    return key
  },
}))

beforeEach(() => {
  setOnMock.mockReset()
  chatState = {
    webSearchOnForNextSend: false,
    setWebSearchOnForNextSend: setOnMock,
  }
  settingsState = {}
})

describe("WebSearchToggle", () => {
  it("is disabled when search is globally disabled", () => {
    settingsState = {
      searchEnabled: false,
      searchProviders: {
        tavily: { providerId: "tavily", apiKey: "k", enabled: true, priority: 1 },
      },
    }
    renderWithTooltip(<WebSearchToggle />)
    expect(screen.getByRole("button")).toBeDisabled()
  })

  it("is disabled when no provider is configured", () => {
    settingsState = {
      searchEnabled: true,
      searchProviders: {
        tavily: { providerId: "tavily", apiKey: "", enabled: true, priority: 1 },
      },
    }
    renderWithTooltip(<WebSearchToggle />)
    expect(screen.getByRole("button")).toBeDisabled()
  })

  it("is enabled when a provider is configured and search globally enabled", () => {
    settingsState = {
      searchEnabled: true,
      defaultSearchProvider: "tavily",
      searchProviders: {
        tavily: { providerId: "tavily", apiKey: "k", enabled: true, priority: 1 },
      },
    }
    renderWithTooltip(<WebSearchToggle />)
    expect(screen.getByRole("button")).not.toBeDisabled()
  })

  it("toggles state on click", () => {
    settingsState = {
      searchEnabled: true,
      defaultSearchProvider: "tavily",
      searchProviders: {
        tavily: { providerId: "tavily", apiKey: "k", enabled: true, priority: 1 },
      },
    }
    renderWithTooltip(<WebSearchToggle />)
    fireEvent.click(screen.getByRole("button"))
    expect(setOnMock).toHaveBeenCalledWith(true)
  })

  it("reflects 'on' state via aria-pressed", () => {
    chatState = {
      webSearchOnForNextSend: true,
      setWebSearchOnForNextSend: setOnMock,
    }
    settingsState = {
      searchEnabled: true,
      defaultSearchProvider: "tavily",
      searchProviders: {
        tavily: { providerId: "tavily", apiKey: "k", enabled: true, priority: 1 },
      },
    }
    renderWithTooltip(<WebSearchToggle />)
    const button = screen.getByRole("button")
    expect(button).toHaveAttribute("aria-pressed", "true")
  })

  it("is disabled when the external disabled prop is true, even if search is configured", () => {
    settingsState = {
      searchEnabled: true,
      defaultSearchProvider: "tavily",
      searchProviders: {
        tavily: { providerId: "tavily", apiKey: "k", enabled: true, priority: 1 },
      },
    }
    renderWithTooltip(<WebSearchToggle disabled />)
    expect(screen.getByRole("button")).toBeDisabled()
  })

  it("falls back to first enabled provider when default disabled", () => {
    settingsState = {
      searchEnabled: true,
      defaultSearchProvider: "tavily",
      searchProviders: {
        tavily: { providerId: "tavily", apiKey: "k", enabled: false, priority: 1 },
        perplexity: { providerId: "perplexity", apiKey: "k", enabled: true, priority: 2 },
      },
    }
    renderWithTooltip(<WebSearchToggle />)
    expect(screen.getByRole("button")).not.toBeDisabled()
  })
})
