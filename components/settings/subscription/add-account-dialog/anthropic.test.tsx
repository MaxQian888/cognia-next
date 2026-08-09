/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { Account } from "@/types/subscription"

// next-intl is globally mocked against en.json in jest.setup.ts.

const buildAuthorizeUrlMock = jest.fn()
const exchangeCodeForTokensMock = jest.fn()
jest.mock("@/lib/subscription/anthropic/oauth", () => ({
  buildAuthorizeUrl: (...a: unknown[]) => buildAuthorizeUrlMock(...a),
  exchangeCodeForTokens: (...a: unknown[]) => exchangeCodeForTokensMock(...a),
  extractAuthorizationCode: jest.requireActual("@/lib/subscription/anthropic/oauth")
    .extractAuthorizationCode,
}))

const persistProviderAccountMock = jest.fn()
jest.mock("@/lib/subscription/core/account-lifecycle", () => ({
  persistProviderAccount: (...a: unknown[]) => persistProviderAccountMock(...a),
}))

type Discovered = {
  source: string
  credentialsPath: string
  accessToken: string
  refreshToken: string
  expiresAtMs: number
  scopes: string[]
  subscriptionType?: string
} | null
let discoveredResult: Discovered = null
const reloadDiscovery = jest.fn()
jest.mock("@/lib/subscription/anthropic/hooks", () => ({
  useAnthropicDiscovery: () => ({
    discovered: discoveredResult,
    loading: false,
    error: null,
    reload: reloadDiscovery,
  }),
}))

const savePkceMock = jest.fn()
jest.mock("@/lib/subscription/core/transport", () => ({
  anthropicOauthSavePkceResult: (...a: unknown[]) => savePkceMock(...a),
}))

jest.mock("@/lib/native/opener", () => ({ openUrl: jest.fn() }))

import { AnthropicAddAccountDialog } from "./anthropic"

function discovered(): NonNullable<Discovered> {
  return {
    source: "keyring",
    credentialsPath: "/home/u/.claude/.credentials.json",
    accessToken: "sk-ant-oat01-test",
    refreshToken: "sk-ant-ort01-test",
    expiresAtMs: 1_783_590_329_176,
    scopes: ["user:inference"],
    subscriptionType: "max",
  }
}

function account(): Account {
  return {
    id: "acc-1",
    credential: {
      provider: "anthropic",
      accessToken: "sk",
      refreshToken: "",
      expiresAtMs: 0,
      mode: "subscription",
      storedAtMs: 0,
    },
    createdAtMs: 0,
    lastUsedAtMs: 0,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  discoveredResult = null
})

describe("AnthropicAddAccountDialog", () => {
  it("greys out the reuse mode and defaults to subscription when nothing is discovered", () => {
    render(<AnthropicAddAccountDialog open onOpenChange={() => {}} />)
    expect(screen.getByRole("radio", { name: /reuse claude code login/i })).toBeDisabled()
    expect(screen.getByRole("radio", { name: /subscription \(pro \/ max\)/i })).toBeChecked()
    expect(screen.getByRole("button", { name: /open authorization page/i })).toBeInTheDocument()
  })

  it("defaults to reuse when a local login is discovered and shows its details", () => {
    discoveredResult = discovered()
    render(<AnthropicAddAccountDialog open onOpenChange={() => {}} />)
    expect(screen.getByRole("radio", { name: /reuse claude code login/i })).toBeChecked()
    expect(screen.getByText("/home/u/.claude/.credentials.json")).toBeInTheDocument()
    expect(screen.getByText("max")).toBeInTheDocument()
    // No PKCE CTA while in reuse mode.
    expect(
      screen.queryByRole("button", { name: /open authorization page/i })
    ).not.toBeInTheDocument()
  })

  it("adopts the discovered login and closes", async () => {
    discoveredResult = discovered()
    savePkceMock.mockResolvedValueOnce(account())
    persistProviderAccountMock.mockResolvedValueOnce(account())
    const onAdded = jest.fn()
    render(<AnthropicAddAccountDialog open onOpenChange={() => {}} onAdded={onAdded} />)

    await userEvent.click(screen.getByRole("button", { name: /adopt this login/i }))

    await waitFor(() => expect(onAdded).toHaveBeenCalled())
    expect(savePkceMock).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "sk-ant-oat01-test" }),
      null
    )
    expect(persistProviderAccountMock).toHaveBeenCalledWith("anthropic", account())
  })

  it("surfaces an adopt failure and returns to the mode chooser", async () => {
    discoveredResult = discovered()
    savePkceMock.mockResolvedValueOnce(account())
    persistProviderAccountMock.mockRejectedValueOnce(new Error("vault sealed"))
    render(<AnthropicAddAccountDialog open onOpenChange={() => {}} />)

    await userEvent.click(screen.getByRole("button", { name: /adopt this login/i }))

    expect(await screen.findByText(/vault sealed/)).toBeInTheDocument()
    expect(screen.getByRole("radio", { name: /reuse claude code login/i })).toBeInTheDocument()
  })

  it("replaces credentials without changing the existing account identity", async () => {
    discoveredResult = discovered()
    const existing = {
      ...account(),
      id: "existing-id",
      label: "Personal",
      presetId: "preset-1",
      createdAtMs: 123,
    }
    persistProviderAccountMock.mockImplementation(async (_provider, next) => next)
    render(<AnthropicAddAccountDialog open onOpenChange={() => {}} existingAccount={existing} />)

    await userEvent.click(screen.getByRole("button", { name: /adopt this login/i }))

    await waitFor(() =>
      expect(persistProviderAccountMock).toHaveBeenCalledWith(
        "anthropic",
        expect.objectContaining({
          id: "existing-id",
          label: "Personal",
          presetId: "preset-1",
          createdAtMs: 123,
        })
      )
    )
    expect(savePkceMock).not.toHaveBeenCalled()
  })

  it("starts the PKCE flow when a non-reuse mode is chosen", async () => {
    discoveredResult = discovered()
    buildAuthorizeUrlMock.mockResolvedValueOnce({
      url: "https://claude.ai/oauth/authorize?x=1",
      flowState: { state: "s", verifier: "v", mode: "subscription" },
    })
    render(<AnthropicAddAccountDialog open onOpenChange={() => {}} />)

    await userEvent.click(screen.getByRole("radio", { name: /subscription \(pro \/ max\)/i }))
    await userEvent.click(screen.getByRole("button", { name: /open authorization page/i }))

    expect(buildAuthorizeUrlMock).toHaveBeenCalledWith({ mode: "subscription" })
    expect(await screen.findByLabelText(/authorization code/i)).toBeInTheDocument()
  })

  it("re-scan asks the discovery hook to reload", async () => {
    discoveredResult = null
    render(<AnthropicAddAccountDialog open onOpenChange={() => {}} initialMode="reuse" />)
    await userEvent.click(screen.getByRole("button", { name: /re-scan/i }))
    expect(reloadDiscovery).toHaveBeenCalled()
  })
})
