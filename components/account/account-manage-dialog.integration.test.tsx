/**
 * @jest-environment jsdom
 *
 * Full-tree integration smoke: renders the REAL composed dialog (shell → list →
 * detail → real Radix Tabs → real ProfileAvatarPicker / AutoLockControl) against
 * a seeded store, with nothing but the stores + next-intl mocked. The unit tests
 * mock children or the store in isolation, so this is the only test that proves
 * the pieces actually compose and render together (the dialog is Tauri-only, so
 * this stands in for launching the desktop app).
 */

import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TooltipProvider } from "@/components/ui/tooltip"
import type { LocalAccountRecord } from "@/lib/accounts/account-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, string>) =>
    values ? `${key}:${Object.values(values).join(",")}` : key,
  // The lock-screen backdrop formats its clock and date through next-intl.
  useFormatter: () => ({ dateTime: (value: Date) => value.toISOString() }),
}))

const noop = jest.fn()
let accounts: LocalAccountRecord[]
const storeState = () => ({
  accounts,
  activeAccountId: "acct_alpha",
  unlockedAccountId: "acct_alpha",
  error: null,
  createAccount: noop,
  renameAccount: noop,
  changePassword: noop,
  deleteAccount: noop,
  setAccountAvatar: noop,
  switchAccount: noop,
  lock: noop,
})
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: (selector: (s: ReturnType<typeof storeState>) => unknown) =>
    selector(storeState()),
}))
jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T,>(selector: (s: { settings: object; save: jest.Mock }) => T) =>
    selector({ settings: {}, save: noop }),
}))

import { AccountManageDialog } from "./account-manage-dialog"

function account(id: string, displayName: string): LocalAccountRecord {
  return {
    id,
    displayName,
    passwordVerifier: { algorithm: "a", salt: "s", hash: "h", params: {} },
    createdAt: Date.UTC(2024, 0, 1, 12),
    updatedAt: Date.UTC(2024, 0, 2, 12),
  }
}

beforeEach(() => {
  accounts = [account("acct_alpha", "Alpha"), account("acct_beta", "Beta")]
})

describe("AccountManageDialog (full-tree integration)", () => {
  it("composes the list, detail header, and all three tabs against a real store", async () => {
    const user = userEvent.setup()
    render(
      <TooltipProvider>
        <AccountManageDialog open onOpenChange={jest.fn()} />
      </TooltipProvider>
    )

    // List column with a row per account + the create toggle.
    expect(screen.getByTestId("account-list")).toBeInTheDocument()
    expect(screen.getByTestId("account-manage-row-acct_alpha")).toBeInTheDocument()
    expect(screen.getByTestId("account-manage-row-acct_beta")).toBeInTheDocument()
    expect(screen.getByTestId("account-create-toggle")).toBeInTheDocument()

    // Detail defaults to the active (first) account and its Profile tab.
    expect(screen.getByTestId("account-detail-active")).toBeInTheDocument()
    expect(screen.getByTestId("account-profile-tab")).toBeInTheDocument()

    // Security tab renders the real change-password form + the shared
    // AutoLockControl + Lock now.
    await user.click(screen.getByTestId("account-tab-security"))
    const securityTab = screen.getByTestId("account-security-tab")
    expect(within(securityTab).getByLabelText("currentPasswordLabel")).toBeInTheDocument()
    expect(screen.getByTestId("account-auto-lock-select")).toBeInTheDocument()
    expect(screen.getByTestId("account-security-lock-now")).toBeInTheDocument()

    // Danger tab renders the delete control.
    await user.click(screen.getByTestId("account-tab-danger"))
    expect(screen.getByTestId("account-danger-delete")).toBeInTheDocument()
  })
})
