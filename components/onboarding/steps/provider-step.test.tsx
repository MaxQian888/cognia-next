/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("sonner", () => ({ toast: { error: jest.fn() } }))

const setActiveAccount = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/subscription/core/transport", () => ({
  setActiveAccount: (...a: unknown[]) => setActiveAccount(...a),
}))

const setApiKey = jest.fn().mockResolvedValue(undefined)
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: (selector: (s: { setApiKey: unknown }) => unknown) => selector({ setApiKey }),
}))

// The production OAuth dialogs are reused verbatim; stub them so this suite
// exercises the step's own wiring rather than three credential flows.
jest.mock("@/components/settings/subscription/add-account-dialog/anthropic", () => ({
  AnthropicAddAccountDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="dlg-anthropic" /> : null,
}))
jest.mock("@/components/settings/subscription/add-account-dialog/codex", () => ({
  CodexAddAccountDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="dlg-codex" /> : null,
}))
jest.mock("@/components/settings/subscription/add-account-dialog/opencode", () => ({
  OpencodeAddAccountDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="dlg-opencode" /> : null,
}))

import { ProviderStep } from "./provider-step"
import { toast } from "sonner"

beforeEach(() => jest.clearAllMocks())

describe("ProviderStep", () => {
  it("offers all four sign-in surfaces", () => {
    render(<ProviderStep onConnected={jest.fn()} />)
    for (const k of ["claude", "codex", "opencode", "apiKey"]) {
      expect(screen.getByTestId(`onboarding-provider-${k}`)).toBeInTheDocument()
    }
  })

  it("opens the production OAuth dialog rather than reimplementing the flow", () => {
    render(<ProviderStep onConnected={jest.fn()} />)
    fireEvent.click(screen.getByTestId("onboarding-provider-claude"))
    expect(screen.getByTestId("dlg-anthropic")).toBeInTheDocument()
  })

  it("refuses a blank API key instead of advancing", async () => {
    const onConnected = jest.fn()
    render(<ProviderStep onConnected={onConnected} />)
    fireEvent.click(screen.getByTestId("onboarding-provider-save-key"))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("toastNeedKey"))
    expect(onConnected).not.toHaveBeenCalled()
  })

  it("saves a pasted key and advances", async () => {
    const onConnected = jest.fn()
    render(<ProviderStep onConnected={onConnected} />)
    fireEvent.change(screen.getByLabelText("apiKeyLabel"), { target: { value: " sk-ant-x " } })
    fireEvent.click(screen.getByTestId("onboarding-provider-save-key"))
    await waitFor(() => expect(setApiKey).toHaveBeenCalledWith("sk-ant-x"))
    expect(onConnected).toHaveBeenCalled()
  })

  it("keeps the user on the step when saving the key fails", async () => {
    setApiKey.mockRejectedValueOnce(new Error("keyring locked"))
    const onConnected = jest.fn()
    render(<ProviderStep onConnected={onConnected} />)
    fireEvent.change(screen.getByLabelText("apiKeyLabel"), { target: { value: "sk-ant-x" } })
    fireEvent.click(screen.getByTestId("onboarding-provider-save-key"))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("keyring locked"))
    expect(onConnected).not.toHaveBeenCalled()
  })
})
