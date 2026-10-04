import { useState } from "react"
import { render, screen, fireEvent, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TooltipProvider } from "@/components/ui/tooltip"
import {
  ComposerMenuCloseProvider,
  ComposerMenuPanelsProvider,
  type ComposerMenuPanels,
} from "./composer-menu-context"
import { WEB_SEARCH_SETUP_MENU_PANEL_ID, WebSearchToggle } from "./web-search-toggle"

function renderWithTooltip(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>)
}

const setOnMock = jest.fn()
const openSettingsMock = jest.fn()
const closeMenuMock = jest.fn()

let chatState: {
  webSearchOnForNextSend: boolean
  setWebSearchOnForNextSend: (v: boolean) => void
} = {
  webSearchOnForNextSend: false,
  setWebSearchOnForNextSend: setOnMock,
}
// `undefined` models a settings store that has not hydrated yet.
let settingsState:
  | {
      webTools?: { enabled?: boolean }
      searchEnabled?: boolean
      searchProviders?: Record<
        string,
        { providerId: string; apiKey: string; enabled: boolean; priority: number; cx?: string }
      >
      defaultSearchProvider?: string
    }
  | undefined = {}

jest.mock("@/stores/chat", () => ({
  useChatStore: <T,>(selector: (s: typeof chatState) => T) => selector(chatState),
  // The toggle reads its own conversation's flag now, matching where it writes.
  useComposerWebSearchOn: () => chatState.webSearchOnForNextSend,
}))

const mockIsMobile = { current: false }
jest.mock("@/hooks/ui/use-mobile", () => ({ useIsMobile: () => mockIsMobile.current }))

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

const configuredProvider = {
  tavily: { providerId: "tavily", apiKey: "k", enabled: true, priority: 1 },
}

function renderToggle(props: { disabled?: boolean } = {}) {
  return renderWithTooltip(
    <ComposerMenuCloseProvider value={closeMenuMock}>
      <WebSearchToggle onOpenSettings={openSettingsMock} {...props} />
    </ComposerMenuCloseProvider>
  )
}

// Click the row (opens the setup card), then the card's jump button.
async function openSetupAndJump() {
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: "ariaToggleWebSearch" }))
  await user.click(screen.getByRole("button", { name: "goToSettings" }))
}

beforeEach(() => {
  mockIsMobile.current = false
  setOnMock.mockReset()
  openSettingsMock.mockReset()
  closeMenuMock.mockReset()
  chatState = {
    webSearchOnForNextSend: false,
    setWebSearchOnForNextSend: setOnMock,
  }
  settingsState = {}
})

describe("WebSearchToggle", () => {
  it("prompts with Settings → Web search when the master switch is off", async () => {
    settingsState = {
      searchEnabled: false,
      searchProviders: configuredProvider,
    }
    const user = userEvent.setup()
    renderToggle()
    const row = screen.getByRole("button", { name: "ariaToggleWebSearch" })
    // Not a toggle any more: no pressed state, and the row stays clickable
    // because it opens the setup card.
    expect(row).not.toBeDisabled()
    expect(row).not.toHaveAttribute("aria-pressed")
    await user.click(row)
    // The card names the blocker; nothing has navigated yet.
    expect(screen.getByText("setupSwitchOff")).toBeInTheDocument()
    expect(openSettingsMock).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "goToSettings" }))
    expect(openSettingsMock).toHaveBeenCalledWith("search")
    expect(closeMenuMock).toHaveBeenCalledTimes(1)
    expect(setOnMock).not.toHaveBeenCalled()
  })

  it("prompts with Settings → Web search when no provider is configured", async () => {
    settingsState = {
      searchEnabled: true,
      searchProviders: {
        tavily: { providerId: "tavily", apiKey: "", enabled: true, priority: 1 },
      },
    }
    renderToggle()
    await openSetupAndJump()
    expect(openSettingsMock).toHaveBeenCalledWith("search")
  })

  it("prompts with Settings → Tools when the web-tools capability is off", async () => {
    settingsState = {
      webTools: { enabled: false },
      searchEnabled: true,
      searchProviders: configuredProvider,
    }
    const user = userEvent.setup()
    renderToggle()
    await user.click(screen.getByRole("button", { name: "ariaToggleWebSearch" }))
    expect(screen.getByText("setupToolsOff")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "goToSettings" }))
    expect(openSettingsMock).toHaveBeenCalledWith("tools")
  })

  it("treats a not-yet-loaded settings store as needing setup", async () => {
    // `settings === undefined` → every `settings?.` guard takes its nullish
    // branch and the master switch reads as off, so the card offers the
    // Settings → Web search route.
    settingsState = undefined
    renderToggle()
    await openSetupAndJump()
    expect(openSettingsMock).toHaveBeenCalledWith("search")
  })

  it("stays plainly disabled when unavailable and there is no settings route", () => {
    settingsState = { searchEnabled: false, searchProviders: configuredProvider }
    renderWithTooltip(<WebSearchToggle />)
    expect(screen.getByRole("button")).toBeDisabled()
  })

  it("is enabled when a provider is configured and search globally enabled", () => {
    settingsState = {
      searchEnabled: true,
      defaultSearchProvider: "tavily",
      searchProviders: configuredProvider,
    }
    renderToggle()
    expect(screen.getByRole("button")).not.toBeDisabled()
  })

  it("toggles state on click", () => {
    settingsState = {
      searchEnabled: true,
      defaultSearchProvider: "tavily",
      searchProviders: configuredProvider,
    }
    renderToggle()
    fireEvent.click(screen.getByRole("button"))
    // The trailing arg is the composer's conversation — `undefined` outside a
    // `ComposerSessionProvider`, which the store reads as "the focused one".
    expect(setOnMock).toHaveBeenCalledWith(true, undefined)
  })

  it("reflects 'on' state via aria-pressed", () => {
    chatState = {
      webSearchOnForNextSend: true,
      setWebSearchOnForNextSend: setOnMock,
    }
    settingsState = {
      searchEnabled: true,
      defaultSearchProvider: "tavily",
      searchProviders: configuredProvider,
    }
    renderToggle()
    const button = screen.getByRole("button")
    expect(button).toHaveAttribute("aria-pressed", "true")
  })

  it("is disabled when the external disabled prop is true, even if search is configured", () => {
    settingsState = {
      searchEnabled: true,
      defaultSearchProvider: "tavily",
      searchProviders: configuredProvider,
    }
    renderToggle({ disabled: true })
    expect(screen.getByRole("button")).toBeDisabled()
  })

  it("still offers the setup card while a turn is streaming", async () => {
    settingsState = { searchEnabled: false, searchProviders: configuredProvider }
    renderToggle({ disabled: true })
    await openSetupAndJump()
    expect(openSettingsMock).toHaveBeenCalledWith("search")
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
    renderToggle()
    expect(screen.getByRole("button")).not.toBeDisabled()
  })

  // The setup card is a second-level panel off a `+` menu row. On a phone it
  // flew out to the right of a menu that already spans the screen and was
  // entirely off-screen; it stacks above the row there instead.
  it("places the setup card beside the row on desktop and above it on a phone", async () => {
    settingsState = { searchEnabled: false }
    const user = userEvent.setup()
    const { unmount } = renderToggle()
    await user.click(screen.getByRole("button", { name: "ariaToggleWebSearch" }))
    // jsdom lays out at 0×0, so Radix may flip the side; the axis is the point.
    expect(["right", "left"]).toContain(
      screen.getByTestId("web-search-setup-flyout").getAttribute("data-side")
    )
    unmount()

    mockIsMobile.current = true
    renderToggle()
    await user.click(screen.getByRole("button", { name: "ariaToggleWebSearch" }))
    expect(["top", "bottom"]).toContain(
      screen.getByTestId("web-search-setup-flyout").getAttribute("data-side")
    )
  })
})

/** A minimal drill-in host standing in for the mobile `+` sheet. */
function SheetHost({
  children,
  registerPanel = () => () => {},
}: {
  children: React.ReactNode
  registerPanel?: (id: string) => () => void
}) {
  const [active, setActive] = useState<{ id: string; title: string } | null>(null)
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  const panels: ComposerMenuPanels = {
    activePanelId: active?.id ?? null,
    slot,
    openPanel: (id, title) => setActive({ id, title }),
    closePanel: () => setActive(null),
    registerPanel,
  }
  return (
    <ComposerMenuPanelsProvider value={panels}>
      {children}
      <p data-testid="sheet-title">{active?.title ?? ""}</p>
      <div data-testid="sheet-slot" ref={setSlot} />
    </ComposerMenuPanelsProvider>
  )
}

describe("WebSearchToggle inside the mobile sheet", () => {
  function renderInSheet(registerPanel?: (id: string) => () => void) {
    return renderWithTooltip(
      <ComposerMenuCloseProvider value={closeMenuMock}>
        <SheetHost {...(registerPanel ? { registerPanel } : {})}>
          <WebSearchToggle onOpenSettings={openSettingsMock} />
        </SheetHost>
      </ComposerMenuCloseProvider>
    )
  }

  it("drills in to the setup card instead of floating it over the sheet", async () => {
    settingsState = { searchEnabled: false, searchProviders: configuredProvider }
    const user = userEvent.setup()
    renderInSheet()
    await user.click(screen.getByRole("button", { name: "ariaToggleWebSearch" }))
    expect(screen.queryByTestId("web-search-setup-flyout")).toBeNull()
    const slot = screen.getByTestId("sheet-slot")
    expect(within(slot).getByTestId("web-search-setup-panel")).toHaveTextContent("setupSwitchOff")
    expect(screen.getByTestId("sheet-title")).toHaveTextContent("webLabel")
    await user.click(within(slot).getByRole("button", { name: "goToSettings" }))
    expect(openSettingsMock).toHaveBeenCalledWith("search")
    expect(closeMenuMock).toHaveBeenCalledTimes(1)
  })

  it("stays a plain toggle with no panel once search is configured", () => {
    settingsState = { searchEnabled: true, searchProviders: configuredProvider }
    const registerPanel = jest.fn(() => () => {})
    renderInSheet(registerPanel)
    fireEvent.click(screen.getByRole("button", { name: "ariaToggleWebSearch" }))
    expect(setOnMock).toHaveBeenCalledWith(true, undefined)
    expect(registerPanel).not.toHaveBeenCalled()
    expect(WEB_SEARCH_SETUP_MENU_PANEL_ID).toBe("web-search-setup")
  })
})
