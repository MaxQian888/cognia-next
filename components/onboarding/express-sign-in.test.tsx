/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
jest.mock("sonner", () => ({ toast: { error: jest.fn() } }))

let standalone = true
jest.mock("@/lib/runtime/standalone-mode", () => ({
  isStandaloneChatMode: () => standalone,
}))

// The credential writes have their own suite (`lib/onboarding/connect-provider`);
// this one is about which surface each shell is offered and what it does next.
const connectSubscriptionAccount = jest.fn().mockResolvedValue({
  provider: "anthropic",
  email: "a@b.c",
})
const saveBuiltInProviderKey = jest.fn().mockResolvedValue({ ok: true })
jest.mock("@/lib/onboarding/connect-provider", () => ({
  connectSubscriptionAccount: (...a: unknown[]) => connectSubscriptionAccount(...a),
  saveBuiltInProviderKey: (...a: unknown[]) => saveBuiltInProviderKey(...a),
}))

let addedAccount: ((account: unknown) => void) | undefined
jest.mock("@/components/settings/subscription/add-account-dialog/anthropic", () => ({
  AnthropicAddAccountDialog: ({
    open,
    onAdded,
  }: {
    open: boolean
    onAdded: (a: unknown) => void
  }) => {
    addedAccount = onAdded
    return open ? <div data-testid="test-anthropic-dialog" /> : null
  },
}))

jest.mock("./steps/provider-step", () => ({
  ProviderStep: ({ heading }: { heading?: boolean }) => (
    <div data-testid="test-provider-step" data-heading={String(heading)} />
  ),
}))

jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      setApiKey: jest.fn().mockResolvedValue(undefined),
      setProviderConfig: jest.fn().mockResolvedValue(undefined),
      setDefaultProvider: jest.fn().mockResolvedValue(undefined),
    }),
}))

import { ExpressSignIn } from "./express-sign-in"

beforeEach(() => {
  jest.clearAllMocks()
  standalone = true
  addedAccount = undefined
  saveBuiltInProviderKey.mockResolvedValue({ ok: true })
})

describe("ExpressSignIn", () => {
  it("offers a key field where subscriptions cannot be used", () => {
    // Subscription accounts live in the OS keyring and resolve through
    // `resolveAccountEnv`, which returns nothing in standalone mode — offering
    // one here would offer something the shell cannot use.
    render(<ExpressSignIn />)
    expect(screen.getByTestId("onboarding-express-key")).toBeInTheDocument()
    expect(screen.queryByTestId("onboarding-express-sign-in-primary")).toBeNull()
  })

  it("offers the subscription button where the keyring is reachable", () => {
    standalone = false
    render(<ExpressSignIn />)
    expect(screen.getByTestId("onboarding-express-sign-in-primary")).toBeInTheDocument()
    expect(screen.queryByTestId("onboarding-express-key")).toBeNull()
  })

  it("keeps Connect inert until there is something to connect with", () => {
    render(<ExpressSignIn />)
    expect(screen.getByTestId("onboarding-express-key-save")).toBeDisabled()
    fireEvent.change(screen.getByTestId("onboarding-express-key"), {
      target: { value: "sk-x" },
    })
    expect(screen.getByTestId("onboarding-express-key-save")).toBeEnabled()
  })

  it("persists a pasted key through the shared writer and reports up", async () => {
    const onConnected = jest.fn()
    render(<ExpressSignIn onConnected={onConnected} />)
    fireEvent.change(screen.getByTestId("onboarding-express-key"), {
      target: { value: "sk-ant-x" },
    })
    fireEvent.click(screen.getByTestId("onboarding-express-key-save"))
    await waitFor(() => expect(saveBuiltInProviderKey).toHaveBeenCalled())
    expect(saveBuiltInProviderKey.mock.calls[0]![0]).toMatchObject({
      draft: { providerId: "anthropic", apiKey: "sk-ant-x", requiresCredential: true },
    })
    await waitFor(() => expect(onConnected).toHaveBeenCalled())
    expect(screen.getByTestId("onboarding-express-connected")).toBeInTheDocument()
  })

  it("does not claim success when the draft was refused", async () => {
    saveBuiltInProviderKey.mockResolvedValue({ ok: false, reason: "incomplete" })
    const onConnected = jest.fn()
    render(<ExpressSignIn onConnected={onConnected} />)
    fireEvent.change(screen.getByTestId("onboarding-express-key"), {
      target: { value: "sk-x" },
    })
    fireEvent.click(screen.getByTestId("onboarding-express-key-save"))
    await waitFor(() => expect(saveBuiltInProviderKey).toHaveBeenCalled())
    expect(onConnected).not.toHaveBeenCalled()
    expect(screen.queryByTestId("onboarding-express-connected")).toBeNull()
  })

  it("routes a subscription through the same shared writer", async () => {
    standalone = false
    const onConnected = jest.fn()
    render(<ExpressSignIn onConnected={onConnected} />)
    fireEvent.click(screen.getByTestId("onboarding-express-sign-in-primary"))
    expect(screen.getByTestId("test-anthropic-dialog")).toBeInTheDocument()

    addedAccount?.({ id: "acc-1" })
    await waitFor(() => expect(connectSubscriptionAccount).toHaveBeenCalled())
    await waitFor(() => expect(onConnected).toHaveBeenCalled())
  })

  it("expands into the real sign-in step, not a second cut-down picker", async () => {
    // All three subscription dialogs and the 77-provider catalogue, with the
    // heading suppressed because the plan line above already says what this is.
    render(<ExpressSignIn />)
    fireEvent.click(screen.getByTestId("onboarding-express-sign-in-more"))
    const step = await screen.findByTestId("test-provider-step")
    expect(step).toHaveAttribute("data-heading", "false")
  })

  it("can be collapsed back to the quick option", async () => {
    render(<ExpressSignIn />)
    fireEvent.click(screen.getByTestId("onboarding-express-sign-in-more"))
    fireEvent.click(await screen.findByTestId("onboarding-express-sign-in-collapse"))
    expect(screen.getByTestId("onboarding-express-key")).toBeInTheDocument()
  })
})
