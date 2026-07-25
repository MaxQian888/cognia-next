/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("../account-list", () => ({
  AccountList: ({ provider, onAdd }: { provider: string; onAdd: () => void }) => (
    <button data-testid={`account-list-${provider}`} onClick={onAdd}>
      add
    </button>
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
  AnthropicAddAccountDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="anthropic-add-dialog" /> : null,
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
    fireEvent.click(screen.getByTestId("account-list-anthropic"))
    expect(screen.getByTestId("anthropic-add-dialog")).toBeInTheDocument()
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
