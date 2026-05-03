/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const isTauriMock = jest.fn(() => true)
jest.mock("@/lib/tauri", () => ({
  isTauri: () => isTauriMock(),
}))

const useStatusMock = jest.fn()
const useProvidersMock = jest.fn()
jest.mock("@/lib/ccswitch/hooks", () => ({
  useCcswitchStatus: (...args: unknown[]) => useStatusMock(...args),
  useCcswitchProviders: (...args: unknown[]) => useProvidersMock(...args),
}))

const detectMock = jest.fn()
jest.mock("@/lib/ccswitch/switch", () => ({
  detectActive: (...args: unknown[]) => detectMock(...args),
}))

const getSettingsMock = jest.fn()
jest.mock("@/lib/db/settings", () => ({
  getSettings: () => getSettingsMock(),
}))

// Stub the dialog so we can observe whether it opened without dragging in
// Radix's portal behaviour.
const dialogProps = jest.fn()
jest.mock("../provider-switch-dialog", () => ({
  ProviderSwitchDialog: (props: Record<string, unknown>) => {
    dialogProps(props)
    return props.open ? <div data-testid="dialog-open" /> : null
  },
}))

import { render, screen, fireEvent, waitFor } from "@testing-library/react"

import { CcswitchProvidersTab } from "./providers-tab"

const providers = [
  { id: "p1", name: "Anthropic Official", apiKey: "sk-x", baseUrl: "https://api.anthropic.com" },
  { id: "p2", name: "Kimi K2", apiKey: "sk-moon", baseUrl: "https://api.moonshot.cn" },
]

beforeEach(() => {
  jest.resetAllMocks()
  isTauriMock.mockReturnValue(true)
  useStatusMock.mockReturnValue({
    data: {
      dbPath: "/x",
      exists: true,
      counts: { providers: 2, mcpServers: 0, prompts: 0, skills: 0 },
    },
    loading: false,
    error: undefined,
    refresh: jest.fn(),
  })
  useProvidersMock.mockReturnValue({
    data: providers,
    loading: false,
    error: undefined,
    refresh: jest.fn(),
  })
  detectMock.mockResolvedValue({ cognia: "p2", agents: {}, drift: false })
  getSettingsMock.mockResolvedValue({
    id: "singleton",
    ccswitchSync: { enabled: true, watchDb: false, defaultPropagation: ["claude-code"] },
    alwaysAllowTools: [],
    builtinTools: {},
  })
})

describe("CcswitchProvidersTab", () => {
  it("renders both providers", async () => {
    render(<CcswitchProvidersTab />)
    expect(await screen.findByText("Anthropic Official")).toBeInTheDocument()
    expect(screen.getByText("Kimi K2")).toBeInTheDocument()
  })

  it("clicking Use here opens the dialog with no agent prefill", async () => {
    render(<CcswitchProvidersTab />)
    await screen.findByText("Anthropic Official")
    // Wait for detectActive to resolve so the sort order is stable.
    await waitFor(() => expect(detectMock).toHaveBeenCalled())
    // Active provider (p2 / Kimi) sorts to the top; the first row's
    // "Use here" button is therefore p2's. Click p1's row instead.
    const buttons = screen.getAllByRole("button", { name: "providers.useHere" })
    fireEvent.click(buttons[1])
    await waitFor(() => expect(screen.getByTestId("dialog-open")).toBeInTheDocument())
    const lastCall = dialogProps.mock.calls.at(-1)![0]
    expect(lastCall.initialAgents).toEqual([])
    expect(lastCall.provider.id).toBe("p1")
  })

  it("clicking 'Use here & in…' prefills with the saved propagation list", async () => {
    render(<CcswitchProvidersTab />)
    await screen.findByText("Kimi K2")
    await waitFor(() => expect(getSettingsMock).toHaveBeenCalled())
    const buttons = screen.getAllByRole("button", { name: "providers.useHereAndIn" })
    fireEvent.click(buttons[1])
    await waitFor(() => expect(screen.getByTestId("dialog-open")).toBeInTheDocument())
    const lastCall = dialogProps.mock.calls.at(-1)![0]
    expect(lastCall.initialAgents).toEqual(["claude-code"])
  })

  it("renders empty state when there are no providers", () => {
    useProvidersMock.mockReturnValue({
      data: [],
      loading: false,
      error: undefined,
      refresh: jest.fn(),
    })
    render(<CcswitchProvidersTab />)
    expect(screen.getByText("providers.emptyTitle")).toBeInTheDocument()
  })

  it("renders error alert when listing fails", () => {
    useProvidersMock.mockReturnValue({
      data: undefined,
      loading: false,
      error: "boom",
      refresh: jest.fn(),
    })
    render(<CcswitchProvidersTab />)
    expect(screen.getByText("providers.errorTitle")).toBeInTheDocument()
    expect(screen.getByText("boom")).toBeInTheDocument()
  })

  it("hides the section in web mode", () => {
    isTauriMock.mockReturnValue(false)
    render(<CcswitchProvidersTab />)
    expect(screen.getByText("overview.webModeBody")).toBeInTheDocument()
  })
})
