/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("./account-list", () => ({
  AccountList: ({ provider }: { provider: string }) => (
    <div data-testid={`account-list-${provider}`} />
  ),
}))

jest.mock("./preset-picker", () => ({
  PresetPicker: ({ provider }: { provider: string }) => (
    <div data-testid={`preset-picker-${provider}`} />
  ),
}))

jest.mock("./add-account-dialog/codex", () => ({
  CodexAddAccountDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="codex-add-dialog" /> : null,
}))

const saveMock = jest.fn(async (_: unknown) => undefined)
type MockCodexSettings = {
  autoRefreshNearExpiry: boolean
  probeEnabled: boolean
  visibleIntervalMs: number
  idleIntervalMs: number
  warnThresholdPct: number
}
const defaultMockCodexSettings: MockCodexSettings = {
  autoRefreshNearExpiry: true,
  probeEnabled: false,
  visibleIntervalMs: 5 * 60_000,
  idleIntervalMs: 30 * 60_000,
  warnThresholdPct: 90,
}
const mockSettingsState: { codexSubscriptionSettings: MockCodexSettings } = {
  codexSubscriptionSettings: { ...defaultMockCodexSettings },
}

jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: <T,>(
    selector: (s: {
      settings: typeof mockSettingsState
      save: (patch: unknown) => Promise<void>
    }) => T
  ) =>
    selector({
      settings: mockSettingsState,
      save: (patch: unknown) => saveMock(patch),
    }),
}))

import { ProviderTabCodex } from "./provider-tab-codex"

beforeEach(() => {
  saveMock.mockClear()
  mockSettingsState.codexSubscriptionSettings = { ...defaultMockCodexSettings }
})

describe("ProviderTabCodex", () => {
  it("renders the account list, preset picker, and connection settings card", () => {
    render(<ProviderTabCodex />)
    expect(screen.getByTestId("account-list-codex")).toBeInTheDocument()
    expect(screen.getByTestId("preset-picker-codex")).toBeInTheDocument()
    expect(screen.getByText("cardTitle")).toBeInTheDocument()
  })

  it("shows the connection-settings toggle when the card is expanded", () => {
    render(<ProviderTabCodex />)
    // SettingsCard is collapsible defaultOpen=false; clicking the header opens it.
    fireEvent.click(screen.getByText("cardTitle"))
    expect(screen.getByText("autoRefresh.title")).toBeInTheDocument()
  })

  it("no longer offers a live-discovery toggle", () => {
    // Codex env injection now requires an explicitly adopted account, so there
    // is no setting to opt into reading ~/.codex/auth.json behind the scenes.
    render(<ProviderTabCodex />)
    fireEvent.click(screen.getByText("cardTitle"))
    expect(screen.queryByText("preferDiscovered.title")).not.toBeInTheDocument()
  })

  it("invokes save with patched settings when autoRefresh toggles", async () => {
    render(<ProviderTabCodex />)
    fireEvent.click(screen.getByText("cardTitle"))
    // By id, not by position: this indexed `switches[1]` behind the
    // since-removed discovery toggle, so removing that silently retargeted it.
    fireEvent.click(document.getElementById("codex-auto-refresh")!)
    await waitFor(() => {
      expect(saveMock).toHaveBeenCalledWith({
        codexSubscriptionSettings: { ...defaultMockCodexSettings, autoRefreshNearExpiry: false },
      })
    })
  })

  it("toggles background usage probing and persists probeEnabled", async () => {
    render(<ProviderTabCodex />)
    fireEvent.click(screen.getByText("probe.cardTitle"))
    // Collapsed cards unmount their content, so only the probe card's switch
    // is mounted here.
    const switches = screen.getAllByRole("switch")
    fireEvent.click(switches[0])
    await waitFor(() => {
      expect(saveMock).toHaveBeenCalledWith({
        codexSubscriptionSettings: { ...defaultMockCodexSettings, probeEnabled: true },
      })
    })
  })

  it("clamps a too-fast visible cadence to the floor on save", async () => {
    mockSettingsState.codexSubscriptionSettings = {
      ...defaultMockCodexSettings,
      probeEnabled: true,
    }
    render(<ProviderTabCodex />)
    fireEvent.click(screen.getByText("probe.cardTitle"))
    const visible = screen.getByLabelText("probe.visibleLabel")
    fireEvent.change(visible, { target: { value: "5" } }) // 5s → below 60s floor
    await waitFor(() => {
      expect(saveMock).toHaveBeenCalledWith({
        codexSubscriptionSettings: {
          ...mockSettingsState.codexSubscriptionSettings,
          visibleIntervalMs: 60_000,
        },
      })
    })
  })
})
