/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => {
    const t = (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${JSON.stringify(values)}` : key
    return t
  },
}))

jest.mock("./preset-picker", () => ({
  PresetPicker: ({ provider }: { provider: string }) => (
    <div data-testid={`preset-picker-${provider}`} />
  ),
}))

jest.mock("./provider-quota-panel", () => ({
  ProviderQuotaPanel: ({ provider }: { provider: string }) => (
    <div data-testid={`quota-panel-${provider}`} />
  ),
}))

const discoveryState: {
  discovered: {
    authJsonPath: string
    entries: Array<{ subProvider: string; kind: string; payloadJson: string }>
  } | null
  loading: boolean
  error: string | null
  reload: () => Promise<void>
} = {
  discovered: null,
  loading: false,
  error: null,
  reload: jest.fn(async () => {}),
}

jest.mock("@/lib/subscription/opencode/discovery", () => ({
  useOpencodeDiscovery: () => discoveryState,
}))

const opencodeAdoptDiscovered = jest.fn(async () => {})
jest.mock("@/lib/subscription/core/transport", () => ({
  opencodeAdoptDiscovered: (...args: unknown[]) => opencodeAdoptDiscovered(...args),
}))

jest.mock("@/components/ui/sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}))

import { ProviderTabOpencode } from "./provider-tab-opencode"

// The panel refuses to render in web mode (the credential vault is
// keychain-backed), so the suite has to declare itself desktop.
const TAURI_MARKER = "__TAURI_INTERNALS__"
function setDesktop(on: boolean) {
  if (on) {
    ;(window as unknown as Record<string, unknown>)[TAURI_MARKER] = {}
  } else {
    delete (window as unknown as Record<string, unknown>)[TAURI_MARKER]
  }
}
beforeAll(() => setDesktop(true))
afterAll(() => setDesktop(false))

beforeEach(() => {
  jest.clearAllMocks()
  discoveryState.discovered = {
    authJsonPath: "/home/u/.local/share/opencode/auth.json",
    entries: [
      { subProvider: "opencode", kind: "api-key", payloadJson: '{"type":"api","key":"sk"}' },
      { subProvider: "anthropic", kind: "api-key", payloadJson: '{"apiKey":"sk-ant"}' },
    ],
  }
  discoveryState.loading = false
  discoveryState.error = null
})

describe("ProviderTabOpencode", () => {
  it("renders quota guidance and discovery without account CRUD", () => {
    render(<ProviderTabOpencode />)
    expect(screen.getByTestId("quota-panel-opencode")).toBeInTheDocument()
    // The console-only quota note replaces a silently-empty panel.
    expect(screen.getByText("quotaConsoleOnly")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "quotaConsoleLink" })).toHaveAttribute(
      "href",
      "https://opencode.ai/docs/zen"
    )
    expect(screen.getByText("opencode")).toBeInTheDocument()
    expect(screen.getByText("anthropic")).toBeInTheDocument()
    expect(screen.queryByTestId("account-list-opencode")).not.toBeInTheDocument()
  })

  // Account Center owns account CRUD but cannot see `auth.json`, so this row is
  // the only place the adopt capability is reachable from.
  it("adopts a discovered sub-provider from its row", async () => {
    render(<ProviderTabOpencode />)
    fireEvent.click(screen.getByTestId("opencode-adopt-anthropic"))
    await waitFor(() => expect(opencodeAdoptDiscovered).toHaveBeenCalledWith("anthropic", null))
  })

  it("shows the empty state when nothing whitelisted was discovered", () => {
    discoveryState.discovered = { authJsonPath: "/x/auth.json", entries: [] }
    render(<ProviderTabOpencode />)
    expect(screen.getByText("empty")).toBeInTheDocument()
  })

  it("rescans only when explicitly requested", () => {
    render(<ProviderTabOpencode />)
    fireEvent.click(screen.getByRole("button", { name: "rescan" }))
    expect(discoveryState.reload).toHaveBeenCalledTimes(1)
  })
})

describe("ProviderTabOpencode in web mode", () => {
  beforeEach(() => setDesktop(false))
  afterEach(() => setDesktop(true))

  it("shows the keychain banner instead of a surface that cannot work", () => {
    render(<ProviderTabOpencode />)
    expect(screen.queryByTestId("account-list-opencode")).not.toBeInTheDocument()
    expect(screen.getByText("webModeBanner")).toBeInTheDocument()
  })
})
