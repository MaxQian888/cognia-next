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
jest.mock("@/lib/subscription/core/hooks", () => ({
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
  settings = { defaultProvider: "anthropic", defaultAccountIds: { anthropic: "account-two" } }
  useAccountsMock.mockReturnValue({ accounts, activeAccountId: "account-one" })
  updateSessionMock.mockResolvedValue(undefined)
})

describe("HeaderAccountSwitcher", () => {
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
