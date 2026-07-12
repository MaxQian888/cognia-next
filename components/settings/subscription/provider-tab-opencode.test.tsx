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

jest.mock("./provider-quota-panel", () => ({
  ProviderQuotaPanel: ({ provider }: { provider: string }) => (
    <div data-testid={`quota-panel-${provider}`} />
  ),
}))

jest.mock("./add-account-dialog/opencode", () => ({
  OpencodeAddAccountDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="opencode-add-dialog" /> : null,
}))

const toastSuccess = jest.fn()
const toastError = jest.fn()
jest.mock("@/components/ui/sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}))

const adoptMock = jest.fn(async (_: string) => ({ id: "acc-1" }))
jest.mock("@/lib/subscription/core/transport", () => ({
  opencodeAdoptDiscovered: (sub: string) => adoptMock(sub),
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

import { ProviderTabOpencode } from "./provider-tab-opencode"

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
  it("renders the account list, quota panel with console note, and discovery entries", () => {
    render(<ProviderTabOpencode />)
    expect(screen.getByTestId("account-list-opencode")).toBeInTheDocument()
    expect(screen.getByTestId("quota-panel-opencode")).toBeInTheDocument()
    // The console-only quota note replaces a silently-empty panel.
    expect(screen.getByText("quotaConsoleOnly")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "quotaConsoleLink" })).toHaveAttribute(
      "href",
      "https://opencode.ai/docs/zen"
    )
    expect(screen.getByText("opencode")).toBeInTheDocument()
    expect(screen.getByText("anthropic")).toBeInTheDocument()
  })

  it("adopts a discovered entry and reports success", async () => {
    render(<ProviderTabOpencode />)
    fireEvent.click(screen.getByTestId("opencode-adopt-opencode"))
    await waitFor(() => expect(adoptMock).toHaveBeenCalledWith("opencode"))
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled())
  })

  it("surfaces an adoption failure as an error toast", async () => {
    adoptMock.mockRejectedValueOnce(new Error("keyring locked"))
    render(<ProviderTabOpencode />)
    fireEvent.click(screen.getByTestId("opencode-adopt-anthropic"))
    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(String(toastError.mock.calls[0][0])).toContain("keyring locked")
  })

  it("shows the empty state when nothing whitelisted was discovered", () => {
    discoveryState.discovered = { authJsonPath: "/x/auth.json", entries: [] }
    render(<ProviderTabOpencode />)
    expect(screen.getByText("empty")).toBeInTheDocument()
  })
})
