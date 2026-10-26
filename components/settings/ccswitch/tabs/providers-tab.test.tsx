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
  canSwitchProvider: jest.requireActual("@/lib/ccswitch/switch").canSwitchProvider,
  ccswitchProviderRefId: jest.requireActual("@/lib/ccswitch/switch").ccswitchProviderRefId,
}))

const getSettingsMock = jest.fn()
jest.mock("@/lib/db/settings", () => ({
  getSettings: () => getSettingsMock(),
}))

const saveSettingsMock = jest.fn(async () => {})
let customLimitsSources: unknown[] = []
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) =>
    selector({
      settings: { customLimitsSources },
      save: saveSettingsMock,
    }),
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
  {
    id: "p1",
    kind: "claude",
    name: "Anthropic Official",
    apiKey: "sk-x",
    baseUrl: "https://api.anthropic.com",
  },
  {
    id: "p2",
    kind: "claude",
    name: "Kimi K2",
    apiKey: "sk-moon",
    baseUrl: "https://api.moonshot.cn",
  },
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
  detectMock.mockResolvedValue({ cognia: "ccswitch:claude:p2", agents: {}, drift: false })
  getSettingsMock.mockResolvedValue({
    id: "singleton",
    ccswitchSync: { enabled: true, watchDb: false, defaultPropagation: ["claude-code"] },
    alwaysAllowTools: [],
    builtinTools: {},
  })
  customLimitsSources = []
})

describe("CcswitchProvidersTab", () => {
  it("shows database schema errors instead of an empty successful list", async () => {
    useStatusMock.mockReturnValue({
      data: undefined,
      loading: false,
      error: "unsupported CC Switch schema 22",
      refresh: jest.fn(),
    })
    render(<CcswitchProvidersTab />)
    expect(await screen.findByText("unsupported CC Switch schema 22")).toBeInTheDocument()
  })

  it("renders both providers", async () => {
    render(<CcswitchProvidersTab />)
    expect(await screen.findByText("Anthropic Official")).toBeInTheDocument()
    expect(screen.getByText("Kimi K2")).toBeInTheDocument()
  })

  it("imports recognized CCSwitch usage metadata as a disabled custom source", async () => {
    useProvidersMock.mockReturnValue({
      data: [
        {
          id: "kimi",
          kind: "claude",
          name: "Kimi Coding",
          apiKey: "sk-kimi",
          baseUrl: "https://api.kimi.com/coding",
          usageScript: { templateType: "token_plan", codingPlanProvider: "kimi" },
        },
      ],
      loading: false,
      error: undefined,
      refresh: jest.fn(),
    })
    detectMock.mockResolvedValue({ cognia: undefined, agents: {}, drift: false })

    render(<CcswitchProvidersTab />)
    fireEvent.click(await screen.findByRole("button", { name: "providers.importQuota" }))

    await waitFor(() =>
      expect(saveSettingsMock).toHaveBeenCalledWith({
        customLimitsSources: [
          expect.objectContaining({
            id: "ccswitch:claude:kimi",
            enabled: false,
            request: expect.objectContaining({ path: "/coding/v1/usages" }),
          }),
        ],
      })
    )
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

  it("renders same-id providers from different apps without duplicate React keys", async () => {
    // CCSwitch's providers table is keyed by (id, app_type) — the id alone
    // repeats across apps (e.g. claude/default + codex/default).
    useProvidersMock.mockReturnValue({
      data: [
        { id: "default", name: "Claude Default", kind: "claude" },
        { id: "default", name: "Codex Default", kind: "codex" },
      ],
      loading: false,
      error: undefined,
      refresh: jest.fn(),
    })
    detectMock.mockResolvedValue({ cognia: undefined, agents: {}, drift: false })
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {})
    try {
      render(<CcswitchProvidersTab />)
      expect(await screen.findByText("Claude Default")).toBeInTheDocument()
      expect(screen.getByText("Codex Default")).toBeInTheDocument()
      const dupKeyError = errorSpy.mock.calls.find((call) => String(call[0]).includes("same key"))
      expect(dupKeyError).toBeUndefined()
    } finally {
      errorSpy.mockRestore()
    }
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

it("keeps the active composite identity first", async () => {
  render(<CcswitchProvidersTab />)
  await waitFor(() => expect(screen.getByText("providers.activeBadge")).toBeInTheDocument())
  const buttons = screen.getAllByRole("button", { name: "providers.useHere" })
  fireEvent.click(buttons[0])
  await waitFor(() => expect(dialogProps.mock.calls.at(-1)?.[0].provider?.id).toBe("p2"))
})

it("disables SDK switching for other protocols", async () => {
  useProvidersMock.mockReturnValue({
    data: [{ id: "agy", kind: "agy", name: "Antigravity", apiKey: "fixture" }],
    loading: false,
    refresh: jest.fn(),
  })
  render(<CcswitchProvidersTab />)
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "providers.useHere" })).toBeDisabled()
  )
  expect(screen.getByText("providers.unsupportedProtocol")).toBeInTheDocument()
})

it("shows errors returned inside a successful native status response", () => {
  useStatusMock.mockReturnValue({
    data: { exists: true, error: "missing table: skills" },
    loading: false,
    refresh: jest.fn(),
  })
  render(<CcswitchProvidersTab />)
  expect(screen.getByText("missing table: skills")).toBeInTheDocument()
})
