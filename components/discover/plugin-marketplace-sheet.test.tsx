/**
 * @jest-environment jsdom
 */

import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { PluginMarketplaceEntry } from "@/hooks/plugins/use-plugin-marketplace"

jest.mock("@/lib/native/utils", () => ({
  ...jest.requireActual("@/lib/native/utils"),
  // `InstallButton` gates install on the desktop host, because the download
  // and checksum verification run in the Rust backend. These suites are about
  // what the surface renders and what it calls, not about the gate, which has
  // its own tests in `_shared/install-button.test.tsx`.
  canUseTauriInvoke: () => true,
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    if (vars && Object.keys(vars).length > 0) return key + ":" + JSON.stringify(vars)
    return key
  },
  useLocale: () => "en",
}))

const toastSuccess = jest.fn()
const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (msg: string) => toastSuccess(msg),
    error: (msg: string) => toastError(msg),
  },
}))

let platformValue: "tauri" | "mobile" | "web" = "web"
jest.mock("@/hooks/use-platform", () => ({
  usePlatform: () => platformValue,
}))

interface FakeMarketplaceState {
  query: string
  setQuery: jest.Mock
  state:
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "ready"; results: PluginMarketplaceEntry[] }
    | { kind: "error"; error: string }
  featured: PluginMarketplaceEntry[]
  popular: PluginMarketplaceEntry[]
  recent: PluginMarketplaceEntry[]
  install: jest.Mock<Promise<void>, [string, string?]>
  uninstall: jest.Mock<Promise<void>, [string]>
  refresh: jest.Mock<Promise<void>, []>
  installingId: string | null
}

let market: FakeMarketplaceState
jest.mock("@/hooks/plugins/use-plugin-marketplace", () => ({
  usePluginMarketplace: () => market,
}))

import { PluginMarketplaceSheet } from "./plugin-marketplace-sheet"

const sampleEntries: PluginMarketplaceEntry[] = [
  {
    id: "plug-alpha",
    name: "Alpha",
    version: "1.0.0",
    description: "Sample alpha plugin",
    signed: true,
    type: "plugin",
  },
  {
    id: "plug-beta",
    name: "Beta",
    version: "0.5.0",
    description: "Sample beta plugin",
    signed: false,
    type: "plugin",
  },
]

function makeMarket(overrides: Partial<FakeMarketplaceState> = {}): FakeMarketplaceState {
  return {
    query: "",
    setQuery: jest.fn(),
    state: { kind: "ready", results: [] },
    featured: sampleEntries,
    popular: [],
    recent: [],
    install: jest.fn().mockResolvedValue(undefined),
    uninstall: jest.fn().mockResolvedValue(undefined),
    refresh: jest.fn().mockResolvedValue(undefined),
    installingId: null,
    ...overrides,
  }
}

beforeEach(() => {
  market = makeMarket()
  platformValue = "web"
  toastSuccess.mockReset()
  toastError.mockReset()
})

describe("<PluginMarketplaceSheet />", () => {
  it("renders a Browse marketplace trigger by default", () => {
    render(<PluginMarketplaceSheet installedIds={new Set()} />)
    expect(screen.getByTestId("discover-marketplace-trigger")).toHaveTextContent(
      "marketplace.browse"
    )
  })

  it("opens the sheet and renders the entries when the trigger is clicked", async () => {
    const user = userEvent.setup()
    render(<PluginMarketplaceSheet installedIds={new Set()} />)
    await user.click(screen.getByTestId("discover-marketplace-trigger"))
    expect(screen.getByTestId("discover-marketplace-sheet")).toBeInTheDocument()
    expect(screen.getByTestId("discover-marketplace-row-plug-alpha")).toBeInTheDocument()
    expect(screen.getByTestId("discover-marketplace-row-plug-beta")).toBeInTheDocument()
  })

  it("uses search results when the query is non-empty", async () => {
    market = makeMarket({
      query: "alpha",
      state: { kind: "ready", results: [sampleEntries[0]] },
    })
    const user = userEvent.setup()
    render(<PluginMarketplaceSheet installedIds={new Set()} />)
    await user.click(screen.getByTestId("discover-marketplace-trigger"))
    expect(screen.getByTestId("discover-marketplace-row-plug-alpha")).toBeInTheDocument()
    expect(screen.queryByTestId("discover-marketplace-row-plug-beta")).not.toBeInTheDocument()
  })

  it("renders the installed badge for entries the user already has", async () => {
    const user = userEvent.setup()
    render(<PluginMarketplaceSheet installedIds={new Set(["plug-alpha"])} />)
    await user.click(screen.getByTestId("discover-marketplace-trigger"))
    expect(screen.getByTestId("discover-marketplace-installed-plug-alpha")).toBeInTheDocument()
    // Beta still shows an install button.
    expect(screen.getByTestId("discover-marketplace-install-plug-beta")).toBeInTheDocument()
  })

  it("calls market.install on click and surfaces a success toast", async () => {
    const user = userEvent.setup()
    render(<PluginMarketplaceSheet installedIds={new Set()} />)
    await user.click(screen.getByTestId("discover-marketplace-trigger"))
    await act(async () => {
      await user.click(screen.getByTestId("discover-marketplace-install-plug-alpha"))
    })
    expect(market.install).toHaveBeenCalledWith("plug-alpha", "1.0.0")
    expect(toastSuccess).toHaveBeenCalled()
  })

  it("disables the install button on mobile (Capacitor)", async () => {
    platformValue = "mobile"
    const user = userEvent.setup()
    render(<PluginMarketplaceSheet installedIds={new Set()} />)
    await user.click(screen.getByTestId("discover-marketplace-trigger"))
    const button = screen.getByTestId("discover-marketplace-install-plug-alpha")
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute("aria-disabled", "true")
  })

  it("renders an error message when the marketplace is unreachable", async () => {
    market = makeMarket({ state: { kind: "error", error: "offline" }, featured: [], popular: [] })
    const user = userEvent.setup()
    render(<PluginMarketplaceSheet installedIds={new Set()} />)
    await user.click(screen.getByTestId("discover-marketplace-trigger"))
    expect(screen.getByTestId("discover-marketplace-error")).toHaveTextContent("offline")
  })

  it("renders an empty state when no entries match", async () => {
    market = makeMarket({ featured: [], popular: [] })
    const user = userEvent.setup()
    render(<PluginMarketplaceSheet installedIds={new Set()} />)
    await user.click(screen.getByTestId("discover-marketplace-trigger"))
    expect(screen.getByTestId("discover-marketplace-empty")).toBeInTheDocument()
  })
})
