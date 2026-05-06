/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const buildAuthorizeUrlMock = jest.fn()
const exchangeCodeForTokensMock = jest.fn()
const extractAuthorizationCodeMock = jest.fn()
jest.mock("@/lib/anthropic-subscription/oauth", () => ({
  buildAuthorizeUrl: (...args: unknown[]) => buildAuthorizeUrlMock(...args),
  exchangeCodeForTokens: (...args: unknown[]) => exchangeCodeForTokensMock(...args),
  extractAuthorizationCode: (...args: unknown[]) => extractAuthorizationCodeMock(...args),
}))

const saveCredentialMock = jest.fn()
jest.mock("@/lib/anthropic-subscription/credential-store", () => ({
  saveCredential: (...args: unknown[]) => saveCredentialMock(...args),
}))

const openUrlMock = jest.fn()
jest.mock("@/lib/native/opener", () => ({
  openUrl: (...args: unknown[]) => openUrlMock(...args),
}))

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

import { SubscriptionLoginDialog } from "./login-dialog"
import type { SubscriptionCredential } from "@/lib/anthropic-subscription/types"

const sampleFlowState = {
  state: "STATE-FROZEN",
  codeVerifier: "VERIFIER-FROZEN",
  mode: "subscription" as const,
  redirectUri: "https://platform.claude.com/oauth/code/callback",
}

const sampleCredential: SubscriptionCredential = {
  accessToken: "oat01-test",
  refreshToken: "rt-test",
  expiresAtMs: Date.now() + 3_600_000,
  mode: "subscription",
  scope: "user:profile user:inference",
  email: "user@example.com",
  plan: "pro",
  storedAtMs: Date.now(),
}

beforeEach(() => {
  jest.resetAllMocks()
  jest.useFakeTimers()
  buildAuthorizeUrlMock.mockResolvedValue({
    url: "https://claude.ai/oauth/authorize?code=true&...",
    flowState: sampleFlowState,
  })
  extractAuthorizationCodeMock.mockReturnValue({ code: "AUTH-CODE", state: "STATE-FROZEN" })
  exchangeCodeForTokensMock.mockResolvedValue(sampleCredential)
  saveCredentialMock.mockResolvedValue(undefined)
  openUrlMock.mockResolvedValue(undefined)
})

afterEach(() => {
  jest.useRealTimers()
})

function renderDialog(
  overrides: Partial<React.ComponentProps<typeof SubscriptionLoginDialog>> = {}
) {
  return render(<SubscriptionLoginDialog open={true} onOpenChange={() => {}} {...overrides} />)
}

describe("SubscriptionLoginDialog", () => {
  it("opens on the mode picker by default", () => {
    renderDialog()
    expect(screen.getByText("login.modes.subscription.label")).toBeInTheDocument()
    expect(screen.getByText("login.modes.console.label")).toBeInTheDocument()
  })

  it("starting the flow opens the authorize URL and transitions to the code step", async () => {
    renderDialog()
    fireEvent.click(screen.getByText("login.actions.openAuthorize"))
    await waitFor(() =>
      expect(buildAuthorizeUrlMock).toHaveBeenCalledWith({ mode: "subscription" })
    )
    await waitFor(() => expect(openUrlMock).toHaveBeenCalled())
    expect(await screen.findByLabelText("login.codeFieldLabel")).toBeInTheDocument()
  })

  it("switches to console mode when the user picks it", async () => {
    renderDialog()
    fireEvent.click(screen.getByLabelText(/login.modes.console.label/))
    fireEvent.click(screen.getByText("login.actions.openAuthorize"))
    await waitFor(() => expect(buildAuthorizeUrlMock).toHaveBeenCalledWith({ mode: "console" }))
  })

  it("submits the code, persists the credential, and notifies the caller", async () => {
    const onLoggedIn = jest.fn()
    const onOpenChange = jest.fn()
    renderDialog({ onLoggedIn, onOpenChange })

    fireEvent.click(screen.getByText("login.actions.openAuthorize"))
    const textarea = await screen.findByLabelText("login.codeFieldLabel")
    fireEvent.change(textarea, { target: { value: "AUTH-CODE#STATE-FROZEN" } })
    fireEvent.click(screen.getByText("login.actions.signIn"))

    await waitFor(() =>
      expect(exchangeCodeForTokensMock).toHaveBeenCalledWith({
        code: "AUTH-CODE",
        flowState: sampleFlowState,
      })
    )
    await waitFor(() => expect(saveCredentialMock).toHaveBeenCalledWith(sampleCredential))
    expect(onLoggedIn).toHaveBeenCalledWith(sampleCredential)
    // Auto-close timer (800ms in the component).
    act(() => {
      jest.advanceTimersByTime(900)
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("surfaces a friendly error when the code is malformed", async () => {
    extractAuthorizationCodeMock.mockReturnValue(null)
    renderDialog()
    fireEvent.click(screen.getByText("login.actions.openAuthorize"))
    const textarea = await screen.findByLabelText("login.codeFieldLabel")
    fireEvent.change(textarea, { target: { value: "garbage" } })
    fireEvent.click(screen.getByText("login.actions.signIn"))
    expect(await screen.findByText("login.errors.codeMalformed")).toBeInTheDocument()
    expect(exchangeCodeForTokensMock).not.toHaveBeenCalled()
  })

  it("rejects a state that doesn't match the flow", async () => {
    extractAuthorizationCodeMock.mockReturnValue({ code: "AUTH-CODE", state: "WRONG" })
    renderDialog()
    fireEvent.click(screen.getByText("login.actions.openAuthorize"))
    const textarea = await screen.findByLabelText("login.codeFieldLabel")
    fireEvent.change(textarea, { target: { value: "AUTH-CODE#WRONG" } })
    fireEvent.click(screen.getByText("login.actions.signIn"))
    expect(await screen.findByText("login.errors.stateMismatch")).toBeInTheDocument()
    expect(exchangeCodeForTokensMock).not.toHaveBeenCalled()
  })

  it("surfaces server errors and stays on the code step so the user can retry", async () => {
    exchangeCodeForTokensMock.mockRejectedValue(new Error("token endpoint 400: invalid_grant"))
    renderDialog()
    fireEvent.click(screen.getByText("login.actions.openAuthorize"))
    const textarea = await screen.findByLabelText("login.codeFieldLabel")
    fireEvent.change(textarea, { target: { value: "AUTH-CODE" } })
    fireEvent.click(screen.getByText("login.actions.signIn"))
    expect(await screen.findByText(/invalid_grant/)).toBeInTheDocument()
    // Still on the code step (textarea visible, sign-in button present).
    expect(screen.getByLabelText("login.codeFieldLabel")).toBeInTheDocument()
    expect(saveCredentialMock).not.toHaveBeenCalled()
  })

  it("surfaces buildAuthorizeUrl errors without transitioning steps", async () => {
    buildAuthorizeUrlMock.mockRejectedValue(new Error("boom"))
    renderDialog()
    fireEvent.click(screen.getByText("login.actions.openAuthorize"))
    expect(await screen.findByText(/boom/)).toBeInTheDocument()
    expect(openUrlMock).not.toHaveBeenCalled()
  })
})
