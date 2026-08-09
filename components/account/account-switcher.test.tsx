/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { TooltipProvider } from "@/components/ui/tooltip"
import type { LocalAccountRecord, PasswordVerifierRecord } from "@/lib/accounts/account-types"
import type { AccountStoreState } from "@/stores/account/account-store"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, string>) =>
    values ? `${key}:${Object.values(values).join(",")}` : key,
}))

const mockSwitchAccount = jest.fn<Promise<void>, [string, string?]>()
const mockLock = jest.fn<Promise<void>, []>()

let mockState: Pick<
  AccountStoreState,
  "accounts" | "activeAccountId" | "locked" | "switchAccount" | "lock"
>

jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: (selector: (state: typeof mockState) => unknown) => selector(mockState),
  selectActiveAccount: (state: typeof mockState) =>
    state.accounts.find((account) => account.id === state.activeAccountId) ?? null,
}))

jest.mock("./account-manage-dialog", () => ({
  AccountManageDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="account-manage-dialog" /> : null,
}))

import { AccountSwitcher } from "./account-switcher"

const verifier: PasswordVerifierRecord = {
  algorithm: "argon2id-v1",
  salt: "salt",
  hash: "hash",
  params: {},
}

function account(id: string, displayName: string): LocalAccountRecord {
  return { id, displayName, passwordVerifier: verifier, createdAt: 1, updatedAt: 1 }
}

function setSwitcherState(overrides: Partial<typeof mockState> = {}) {
  mockState = {
    accounts: [account("acct_alpha", "Alpha"), account("acct_beta", "Beta")],
    activeAccountId: "acct_alpha",
    locked: false,
    switchAccount: mockSwitchAccount,
    lock: mockLock,
    ...overrides,
  }
}

function renderSwitcher() {
  return render(
    <TooltipProvider>
      <AccountSwitcher />
    </TooltipProvider>
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  mockSwitchAccount.mockResolvedValue()
  mockLock.mockResolvedValue()
  setSwitcherState()
})

describe("AccountSwitcher", () => {
  it("renders the active account initial and label", () => {
    renderSwitcher()
    expect(screen.getByTestId("account-switcher")).toHaveAttribute("aria-label", "active:Alpha")
    expect(screen.getByTestId("account-switcher")).toHaveTextContent("A")
  })

  it("renders the fallback icon and no-active label when the active id is stale", () => {
    setSwitcherState({ activeAccountId: "missing" })
    renderSwitcher()
    const trigger = screen.getByTestId("account-switcher")
    expect(trigger).toHaveAttribute("aria-label", "noActive")
    expect(trigger).not.toHaveTextContent("A")
  })

  it("lists accounts and marks the active account", () => {
    renderSwitcher()
    fireEvent.click(screen.getByTestId("account-switcher"))
    expect(screen.getByTestId("account-switch-acct_alpha")).toHaveTextContent("Alpha")
    expect(screen.getByTestId("account-switch-acct_beta")).toHaveTextContent("Beta")
    expect(screen.getByText("activeBadge")).toBeInTheDocument()
  })

  it("prompts for a password before switching to another account", async () => {
    renderSwitcher()
    fireEvent.click(screen.getByTestId("account-switcher"))
    fireEvent.click(screen.getByTestId("account-switch-acct_beta"))
    fireEvent.change(screen.getByLabelText("switchPasswordLabel"), {
      target: { value: "beta-password" },
    })
    fireEvent.click(screen.getByRole("button", { name: "confirmSwitch" }))

    await waitFor(() =>
      expect(mockSwitchAccount).toHaveBeenCalledWith("acct_beta", "beta-password")
    )
  })

  it("clicking the active account clears the pending switch form", () => {
    renderSwitcher()
    fireEvent.click(screen.getByTestId("account-switcher"))
    fireEvent.click(screen.getByTestId("account-switch-acct_beta"))
    expect(screen.getByLabelText("switchPasswordLabel")).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("account-switch-acct_alpha"))

    expect(screen.queryByLabelText("switchPasswordLabel")).not.toBeInTheDocument()
  })

  it("shows switch errors", async () => {
    mockSwitchAccount.mockRejectedValueOnce(new Error("bad password"))
    renderSwitcher()
    fireEvent.click(screen.getByTestId("account-switcher"))
    fireEvent.click(screen.getByTestId("account-switch-acct_beta"))
    fireEvent.change(screen.getByLabelText("switchPasswordLabel"), { target: { value: "bad" } })
    fireEvent.click(screen.getByRole("button", { name: "confirmSwitch" }))

    await screen.findByText("bad password")
  })

  it("shows string and fallback switch errors", async () => {
    mockSwitchAccount.mockRejectedValueOnce("locked out")
    renderSwitcher()
    fireEvent.click(screen.getByTestId("account-switcher"))
    fireEvent.click(screen.getByTestId("account-switch-acct_beta"))
    fireEvent.click(screen.getByRole("button", { name: "confirmSwitch" }))
    expect(await screen.findByText("locked out")).toBeInTheDocument()

    mockSwitchAccount.mockRejectedValueOnce({ code: "bad-input" })
    fireEvent.click(screen.getByRole("button", { name: "confirmSwitch" }))
    expect(await screen.findByText("operationFailed")).toBeInTheDocument()
  })

  it("locks the current account and opens the management dialog", async () => {
    renderSwitcher()
    fireEvent.click(screen.getByTestId("account-switcher"))
    fireEvent.click(screen.getByTestId("account-switcher-lock"))
    await waitFor(() => expect(mockLock).toHaveBeenCalled())

    fireEvent.click(screen.getByTestId("account-switcher"))
    fireEvent.click(screen.getByTestId("account-switcher-manage"))
    expect(screen.getByTestId("account-manage-dialog")).toBeInTheDocument()
  })

  it("renders nothing before any local account exists", () => {
    setSwitcherState({ accounts: [], activeAccountId: null })
    const { container } = renderSwitcher()
    expect(container).toBeEmptyDOMElement()
  })
})
