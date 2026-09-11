/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const updateSessionMock = jest.fn()
jest.mock("@/lib/db/sessions", () => ({
  updateSession: (...args: unknown[]) => updateSessionMock(...args),
}))

const useAccountsMock = jest.fn()
let mockAdditionalProviders: Array<{ id: string; name: string; authMode: string; source: string }> =
  []
jest.mock("@/lib/subscription/core/hooks", () => ({
  useSubscriptionProviders: () => [
    ...jest.requireActual("@/lib/subscription/core/provider-registry").listSubscriptionProviders(),
    ...mockAdditionalProviders,
  ],
  useAccounts: (...args: unknown[]) => useAccountsMock(...args),
}))

let settings: Record<string, unknown> = {}
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: { settings: Record<string, unknown> }) => unknown) =>
    selector({ settings }),
}))

import { HeaderAccountSwitcher } from "./header-account-switcher"

const accounts = [
  { id: "account-one", label: "Personal" },
  { id: "account-two", email: "work@example.com" },
]

function session(overrides: Record<string, unknown> = {}) {
  return { id: "session-1", title: "Chat", ...overrides } as never
}

beforeEach(() => {
  jest.clearAllMocks()
  mockAdditionalProviders = []
  settings = { defaultProvider: "anthropic", defaultAccountIds: { anthropic: "account-two" } }
  useAccountsMock.mockReturnValue({ accounts, activeAccountId: "account-one" })
  updateSessionMock.mockResolvedValue(undefined)
})

describe("HeaderAccountSwitcher", () => {
  it("tracks replacement and restoration of an account on the same mounted session", async () => {
    const { rerender } = render(
      <HeaderAccountSwitcher session={session({ accountId: "account-one" })} />
    )
    await userEvent.click(screen.getByTestId("header-account-switcher"))
    await userEvent.click(screen.getByTestId("account-option-account-two"))
    rerender(<HeaderAccountSwitcher session={session({ accountId: "account-two" })} />)
    expect(screen.getByTestId("header-account-switcher")).toHaveTextContent("work@example.com")
    rerender(<HeaderAccountSwitcher session={session({ accountId: "account-one" })} />)
    expect(screen.getByTestId("header-account-switcher")).toHaveTextContent("Personal")
  })

  it("labels manual credentials until the user explicitly chooses a subscription account", async () => {
    settings = { defaultProvider: "codex", providerSettings: { codex: { apiKey: "manual-key" } } }
    render(<HeaderAccountSwitcher session={session()} />)
    expect(screen.getByTestId("header-account-switcher")).toHaveTextContent(
      /manualApiKey|API key from settings/i
    )
    await userEvent.click(screen.getByTestId("header-account-switcher"))
    await userEvent.click(screen.getByTestId("account-option-account-two"))
    expect(screen.getByTestId("header-account-switcher")).toHaveTextContent("work@example.com")
  })

  it("shows the provider-scoped inherited account using the email fallback", () => {
    render(<HeaderAccountSwitcher session={session()} />)

    expect(screen.getByTestId("header-account-switcher")).toHaveTextContent("work@example.com")
  })

  it("clears a session pin and immediately displays the inherited account", async () => {
    render(<HeaderAccountSwitcher session={session({ accountId: "account-one" })} />)

    await userEvent.click(screen.getByTestId("header-account-switcher"))
    await userEvent.click(screen.getByTestId("account-option-inherited"))

    expect(updateSessionMock).toHaveBeenCalledWith("session-1", { accountId: undefined })
    expect(screen.getByTestId("header-account-switcher")).toHaveTextContent("work@example.com")
  })

  it("marks an inherited active account as the effective account", async () => {
    settings = { defaultProvider: "anthropic" }
    render(<HeaderAccountSwitcher session={session()} />)

    await userEvent.click(screen.getByTestId("header-account-switcher"))

    expect(screen.getByTestId("account-option-account-one")).toHaveTextContent(/effective/i)
  })

  it("surfaces a stale explicit account instead of silently displaying another account", () => {
    render(<HeaderAccountSwitcher session={session({ accountId: "missing-account" })} />)

    expect(screen.getByTestId("header-account-switcher")).toHaveTextContent(/missing-/i)
  })

  it("keeps the inherited escape hatch when a stale pin is the only extra choice", async () => {
    useAccountsMock.mockReturnValue({ accounts: [accounts[0]], activeAccountId: "account-one" })
    render(<HeaderAccountSwitcher session={session({ accountId: "missing-account" })} />)

    await userEvent.click(screen.getByTestId("header-account-switcher"))
    await userEvent.click(screen.getByTestId("account-option-inherited"))

    expect(updateSessionMock).toHaveBeenCalledWith("session-1", { accountId: undefined })
  })
})

it.each(["opencode", "commandcode"])(
  "offers the only %s subscription account as an explicit alternative to a manual key",
  async (provider) => {
    settings = { defaultProvider: provider, providerSettings: { [provider]: { apiKey: "manual" } } }
    useAccountsMock.mockReturnValue({ accounts: [accounts[0]], activeAccountId: "account-one" })
    render(<HeaderAccountSwitcher session={session()} />)
    await userEvent.click(screen.getByTestId("header-account-switcher"))
    await userEvent.click(screen.getByTestId("account-option-account-one"))
    expect(screen.getByTestId("header-account-switcher")).toHaveTextContent("Personal")
    await userEvent.click(screen.getByTestId("header-account-switcher"))
    await userEvent.click(screen.getByTestId("account-option-inherited"))
    expect(screen.getByTestId("header-account-switcher")).toHaveTextContent(
      /manualApiKey|API key from settings/i
    )
  }
)

it.each([new Error("save failed"), "save failed"])(
  "keeps the authoritative account when a save fails (%s)",
  async (cause) => {
    updateSessionMock.mockRejectedValue(cause)
    render(<HeaderAccountSwitcher session={session({ accountId: "account-one" })} />)
    await userEvent.click(screen.getByTestId("header-account-switcher"))
    await userEvent.click(screen.getByTestId("account-option-account-two"))
    expect(screen.getByTestId("header-account-switcher")).toHaveTextContent("Personal")
    expect(screen.getByTestId("header-account-switcher")).toBeEnabled()
  }
)

it("hides the picker for a provider without subscription accounts", () => {
  settings = { defaultProvider: "openai" }
  render(<HeaderAccountSwitcher session={session()} />)
  expect(screen.queryByTestId("header-account-switcher")).not.toBeInTheDocument()
})

it("inherits character account overrides before app defaults", () => {
  render(
    <HeaderAccountSwitcher
      session={session()}
      characterProviderId="codex"
      characterAccountIdOverride="account-one"
    />
  )
  expect(screen.getByTestId("header-account-switcher")).toHaveTextContent("Personal")
})

it("uses the legacy default only for its matching provider", () => {
  settings = { defaultProvider: "codex", defaultAccountId: "account-two" }
  const { rerender } = render(<HeaderAccountSwitcher session={session()} />)
  expect(screen.getByTestId("header-account-switcher")).toHaveTextContent("work@example.com")
  rerender(<HeaderAccountSwitcher session={session({ providerOverride: "opencode-go" })} />)
  expect(screen.getByTestId("header-account-switcher")).toHaveTextContent("Personal")
})

it("uses safe id fallback for unnamed accounts and never saves without a session", async () => {
  settings = {}
  useAccountsMock.mockReturnValue({ accounts: [], activeAccountId: undefined })
  render(
    <HeaderAccountSwitcher
      session={null}
      testAccounts={[{ id: "unlabelled-123" }, { id: "another-123" }]}
    />
  )
  await userEvent.click(screen.getByTestId("header-account-switcher"))
  await userEvent.click(screen.getByTestId("account-option-unlabelled-123"))
  expect(updateSessionMock).not.toHaveBeenCalled()
})

it("does not write when selecting the already pinned account", async () => {
  render(<HeaderAccountSwitcher session={session({ accountId: "account-one" })} />)
  await userEvent.click(screen.getByTestId("header-account-switcher"))
  await userEvent.click(screen.getByTestId("account-option-account-one"))
  expect(updateSessionMock).not.toHaveBeenCalled()
})

it("hides a sole inherited account when no credential-source choice exists", () => {
  useAccountsMock.mockReturnValue({ accounts: [accounts[0]], activeAccountId: "account-one" })
  render(<HeaderAccountSwitcher session={session()} />)
  expect(screen.queryByTestId("header-account-switcher")).not.toBeInTheDocument()
})

it("uses registry-defined providers for manual-key and pinned-account selection", async () => {
  mockAdditionalProviders = [
    { id: "custom-service", name: "My Service", authMode: "api-key", source: "custom" },
  ]
  settings = {
    defaultProvider: "custom-service",
    providerSettings: { "custom-service": { apiKey: "manual" } },
  }
  useAccountsMock.mockReturnValue({ accounts: [accounts[0]], activeAccountId: "account-one" })
  render(<HeaderAccountSwitcher session={session()} />)
  expect(useAccountsMock).toHaveBeenCalledWith("custom-service")
  expect(screen.getByTestId("header-account-switcher")).toHaveTextContent(
    /manualApiKey|API key from settings/i
  )
  await userEvent.click(screen.getByTestId("header-account-switcher"))
  await userEvent.click(screen.getByTestId("account-option-account-one"))
  expect(updateSessionMock).toHaveBeenCalledWith("session-1", { accountId: "account-one" })
})
