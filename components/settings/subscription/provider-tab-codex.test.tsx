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
const mockSettingsState: {
  codexSubscriptionSettings: { preferDiscovered: boolean; autoRefreshNearExpiry: boolean }
} = {
  codexSubscriptionSettings: { preferDiscovered: false, autoRefreshNearExpiry: true },
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
  mockSettingsState.codexSubscriptionSettings = {
    preferDiscovered: false,
    autoRefreshNearExpiry: true,
  }
})

describe("ProviderTabCodex", () => {
  it("renders the account list, preset picker, and connection settings card", () => {
    render(<ProviderTabCodex />)
    expect(screen.getByTestId("account-list-codex")).toBeInTheDocument()
    expect(screen.getByTestId("preset-picker-codex")).toBeInTheDocument()
    expect(screen.getByText("cardTitle")).toBeInTheDocument()
  })

  it("shows both connection-settings toggles when the card is expanded", () => {
    render(<ProviderTabCodex />)
    // SettingsCard is collapsible defaultOpen=false; clicking the header opens it.
    fireEvent.click(screen.getByText("cardTitle"))
    expect(screen.getByText("preferDiscovered.title")).toBeInTheDocument()
    expect(screen.getByText("autoRefresh.title")).toBeInTheDocument()
  })

  it("invokes save with patched settings when preferDiscovered toggles", async () => {
    render(<ProviderTabCodex />)
    fireEvent.click(screen.getByText("cardTitle"))
    const switches = screen.getAllByRole("switch")
    fireEvent.click(switches[0])
    await waitFor(() => {
      expect(saveMock).toHaveBeenCalledWith({
        codexSubscriptionSettings: { preferDiscovered: true, autoRefreshNearExpiry: true },
      })
    })
  })

  it("invokes save with patched settings when autoRefresh toggles", async () => {
    render(<ProviderTabCodex />)
    fireEvent.click(screen.getByText("cardTitle"))
    const switches = screen.getAllByRole("switch")
    fireEvent.click(switches[1])
    await waitFor(() => {
      expect(saveMock).toHaveBeenCalledWith({
        codexSubscriptionSettings: { preferDiscovered: false, autoRefreshNearExpiry: false },
      })
    })
  })
})
