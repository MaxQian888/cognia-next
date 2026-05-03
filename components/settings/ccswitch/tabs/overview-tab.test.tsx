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

jest.mock("@tauri-apps/api/core", () => ({
  invoke: jest.fn(),
}))

import { render, screen, waitFor } from "@testing-library/react"

import { CcswitchOverviewTab } from "./overview-tab"

beforeEach(() => {
  jest.resetAllMocks()
  isTauriMock.mockReturnValue(true)
  getSettingsMock.mockResolvedValue({
    id: "singleton",
    ccswitchSync: { enabled: true, watchDb: false, defaultPropagation: [] },
    alwaysAllowTools: [],
    builtinTools: {},
  })
  detectMock.mockResolvedValue({ cognia: undefined, agents: {}, drift: false })
})

describe("CcswitchOverviewTab", () => {
  it("renders the web-mode banner when not in Tauri", () => {
    isTauriMock.mockReturnValue(false)
    useStatusMock.mockReturnValue({
      data: undefined,
      loading: false,
      error: undefined,
      refresh: jest.fn(),
    })
    useProvidersMock.mockReturnValue({
      data: undefined,
      loading: false,
      error: undefined,
      refresh: jest.fn(),
    })
    render(<CcswitchOverviewTab />)
    expect(screen.getByText("overview.webModeBody")).toBeInTheDocument()
  })

  it("shows the not-found card when the DB is missing", () => {
    useStatusMock.mockReturnValue({
      data: {
        dbPath: "/u/.cc-switch/cc-switch.db",
        exists: false,
        counts: { providers: 0, mcpServers: 0, prompts: 0, skills: 0 },
      },
      loading: false,
      error: undefined,
      refresh: jest.fn(),
    })
    useProvidersMock.mockReturnValue({
      data: undefined,
      loading: false,
      error: undefined,
      refresh: jest.fn(),
    })
    render(<CcswitchOverviewTab />)
    expect(screen.getByText("overview.notFoundTitle")).toBeInTheDocument()
    expect(screen.getByText("/u/.cc-switch/cc-switch.db")).toBeInTheDocument()
  })

  it("shows the detected card with counts when the DB is present", async () => {
    useStatusMock.mockReturnValue({
      data: {
        dbPath: "/u/.cc-switch/cc-switch.db",
        exists: true,
        counts: { providers: 3, mcpServers: 2, prompts: 1, skills: 0 },
      },
      loading: false,
      error: undefined,
      refresh: jest.fn(),
    })
    useProvidersMock.mockReturnValue({
      data: [{ id: "p1", name: "Anthropic", apiKey: "sk-x", baseUrl: "https://api.anthropic.com" }],
      loading: false,
      error: undefined,
      refresh: jest.fn(),
    })
    detectMock.mockResolvedValue({ cognia: "p1", agents: {}, drift: false })
    render(<CcswitchOverviewTab />)
    expect(screen.getByText("overview.detectedTitle")).toBeInTheDocument()
    expect(screen.getByText("3")).toBeInTheDocument() // providers count
    await waitFor(() => expect(detectMock).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByText("Anthropic")).toBeInTheDocument())
  })

  it("renders the drift banner when detectActive reports drift", async () => {
    useStatusMock.mockReturnValue({
      data: {
        dbPath: "/x",
        exists: true,
        counts: { providers: 1, mcpServers: 0, prompts: 0, skills: 0 },
      },
      loading: false,
      error: undefined,
      refresh: jest.fn(),
    })
    useProvidersMock.mockReturnValue({
      data: [{ id: "p1", name: "Kimi" }],
      loading: false,
      error: undefined,
      refresh: jest.fn(),
    })
    detectMock.mockResolvedValue({ cognia: "p1", agents: {}, drift: true })
    render(<CcswitchOverviewTab />)
    await waitFor(() => expect(screen.getByText("overview.driftTitle")).toBeInTheDocument())
  })

  it("renders an error alert when the status fetch fails", () => {
    useStatusMock.mockReturnValue({
      data: undefined,
      loading: false,
      error: "boom",
      refresh: jest.fn(),
    })
    useProvidersMock.mockReturnValue({
      data: undefined,
      loading: false,
      error: undefined,
      refresh: jest.fn(),
    })
    render(<CcswitchOverviewTab />)
    expect(screen.getByText("overview.errorTitle")).toBeInTheDocument()
    expect(screen.getByText("boom")).toBeInTheDocument()
  })
})
