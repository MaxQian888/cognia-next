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
  AccountList: ({
    provider,
    onUpdate,
  }: {
    provider: string
    onUpdate?: (account: unknown) => void
  }) => (
    <div data-testid={`account-list-${provider}`}>
      <button
        data-testid="update-discovered"
        onClick={() =>
          onUpdate?.({
            id: "existing-discovered",
            credential: { provider: "opencode-discovered", subProvider: "anthropic" },
          })
        }
      />
      <button
        data-testid="update-zen"
        onClick={() =>
          onUpdate?.({
            id: "existing-zen",
            credential: { provider: "opencode-zen", accessToken: "old", storedAtMs: 0 },
          })
        }
      />
    </div>
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
  OpencodeAddAccountDialog: ({
    open,
    existingAccount,
  }: {
    open: boolean
    existingAccount?: { id: string }
  }) => (open ? <div data-testid="opencode-add-dialog">{existingAccount?.id}</div> : null),
}))

const toastSuccess = jest.fn()
const toastError = jest.fn()
jest.mock("@/components/ui/sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}))

const adoptedAccount = {
  id: "acc-1",
  provider: "opencode",
  variant: "opencode-zen",
  createdAtMs: 0,
  lastUsedAtMs: 0,
}
const adoptMock = jest.fn(async (_: string, _accountId: string | null) => adoptedAccount)
jest.mock("@/lib/subscription/core/transport", () => ({
  opencodeAdoptDiscovered: (sub: string, accountId: string | null) => adoptMock(sub, accountId),
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
    await waitFor(() => expect(adoptMock).toHaveBeenCalledWith("opencode", null))
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled())
  })

  it("surfaces an adoption failure as an error toast", async () => {
    adoptMock.mockRejectedValueOnce(new Error("keyring locked"))
    render(<ProviderTabOpencode />)
    fireEvent.click(screen.getByTestId("opencode-adopt-anthropic"))
    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(String(toastError.mock.calls[0][0])).toContain("keyring locked")
  })

  it("re-adopts a discovered credential into the same account ID", async () => {
    render(<ProviderTabOpencode />)
    fireEvent.click(screen.getByTestId("update-discovered"))

    await waitFor(() => expect(adoptMock).toHaveBeenCalledWith("anthropic", "existing-discovered"))
  })

  it("opens the same-ID editor for a managed-plan account", () => {
    render(<ProviderTabOpencode />)
    fireEvent.click(screen.getByTestId("update-zen"))

    expect(screen.getByTestId("opencode-add-dialog")).toHaveTextContent("existing-zen")
  })

  it("shows the empty state when nothing whitelisted was discovered", () => {
    discoveryState.discovered = { authJsonPath: "/x/auth.json", entries: [] }
    render(<ProviderTabOpencode />)
    expect(screen.getByText("empty")).toBeInTheDocument()
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
