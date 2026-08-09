/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("../account-list", () => ({
  AccountList: ({
    provider,
    onAdd,
    onUpdate,
  }: {
    provider: string
    onAdd: () => void
    onUpdate?: (account: unknown) => void
  }) => (
    <div data-testid={`account-list-${provider}`}>
      <button data-testid="anthropic-add-account" onClick={onAdd}>
        add
      </button>
      <button
        data-testid="anthropic-update-account"
        onClick={() =>
          onUpdate?.({
            id: "existing-anthropic",
            credential: { provider: "anthropic", accessToken: "old", storedAtMs: 0 },
          })
        }
      />
    </div>
  ),
}))
jest.mock("../preset-picker", () => ({
  PresetPicker: ({ provider }: { provider: string }) => (
    <div data-testid={`preset-picker-${provider}`} />
  ),
}))
jest.mock("../provider-quota-panel", () => ({
  ProviderQuotaPanel: ({ provider }: { provider: string }) => (
    <div data-testid={`quota-panel-${provider}`} />
  ),
}))
jest.mock("../tabs/account-tab", () => ({
  SubscriptionAccountTab: () => <div data-testid="account-tab" />,
}))
jest.mock("../add-account-dialog/anthropic", () => ({
  AnthropicAddAccountDialog: ({
    open,
    existingAccount,
  }: {
    open: boolean
    existingAccount?: { id: string }
  }) => (open ? <div data-testid="anthropic-add-dialog">{existingAccount?.id}</div> : null),
}))

import { fireEvent, render, screen } from "@testing-library/react"

import { ClaudeAccountPanel } from "./claude-account-panel"

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

describe("ClaudeAccountPanel", () => {
  it("renders the anthropic account surface", () => {
    render(<ClaudeAccountPanel />)
    expect(screen.getByTestId("account-list-anthropic")).toBeInTheDocument()
    expect(screen.getByTestId("quota-panel-anthropic")).toBeInTheDocument()
    expect(screen.getByTestId("preset-picker-anthropic")).toBeInTheDocument()
    expect(screen.getByTestId("account-tab")).toBeInTheDocument()
  })

  it("opens the add-account dialog on request", () => {
    render(<ClaudeAccountPanel />)
    expect(screen.queryByTestId("anthropic-add-dialog")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("anthropic-add-account"))
    expect(screen.getByTestId("anthropic-add-dialog")).toBeInTheDocument()
  })

  it("opens the same-ID credential update flow", () => {
    render(<ClaudeAccountPanel />)
    fireEvent.click(screen.getByTestId("anthropic-update-account"))

    expect(screen.getByTestId("anthropic-add-dialog")).toHaveTextContent("existing-anthropic")
  })
})

describe("ClaudeAccountPanel in web mode", () => {
  beforeEach(() => setDesktop(false))
  afterEach(() => setDesktop(true))

  it("shows the keychain banner instead of a surface that cannot work", () => {
    render(<ClaudeAccountPanel />)
    expect(screen.queryByTestId("account-list-anthropic")).not.toBeInTheDocument()
    expect(screen.getByText("webModeBanner")).toBeInTheDocument()
  })
})
