/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { LocalAccountRecord, PasswordVerifierRecord } from "@/lib/accounts/account-types"
import type { AccountStoreState } from "@/stores/account/account-store"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, string>) =>
    values ? `${key}:${Object.values(values).join(",")}` : key,
}))

const mockCreateAccount = jest.fn<Promise<LocalAccountRecord>, [unknown]>()
const mockRenameAccount = jest.fn<Promise<LocalAccountRecord>, [string, string]>()
const mockDeleteAccount = jest.fn<Promise<void>, [string, unknown?]>()

let mockState: Pick<
  AccountStoreState,
  "accounts" | "activeAccountId" | "createAccount" | "renameAccount" | "deleteAccount"
>

jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: (selector: (state: typeof mockState) => unknown) => selector(mockState),
}))

import { AccountManageDialog } from "./account-manage-dialog"

const verifier: PasswordVerifierRecord = {
  algorithm: "argon2id-v1",
  salt: "salt",
  hash: "hash",
  params: {},
}

function account(id: string, displayName: string): LocalAccountRecord {
  return { id, displayName, passwordVerifier: verifier, createdAt: 1, updatedAt: 1 }
}

function setManageState(overrides: Partial<typeof mockState> = {}) {
  mockState = {
    accounts: [account("acct_alpha", "Alpha"), account("acct_beta", "Beta")],
    activeAccountId: "acct_alpha",
    createAccount: mockCreateAccount,
    renameAccount: mockRenameAccount,
    deleteAccount: mockDeleteAccount,
    ...overrides,
  }
}

function renderDialog() {
  return render(<AccountManageDialog open onOpenChange={jest.fn()} />)
}

beforeEach(() => {
  jest.clearAllMocks()
  mockCreateAccount.mockResolvedValue(account("acct_created", "Created"))
  mockRenameAccount.mockImplementation(async (id, displayName) => account(id, displayName))
  mockDeleteAccount.mockResolvedValue()
  setManageState()
})

describe("AccountManageDialog", () => {
  it("creates an account from the create form", async () => {
    renderDialog()
    fireEvent.change(screen.getByLabelText("newDisplayNameLabel"), {
      target: { value: "Gamma" },
    })
    fireEvent.change(screen.getByLabelText("newPasswordLabel"), {
      target: { value: "secret" },
    })
    fireEvent.click(screen.getByRole("button", { name: "createAccount" }))

    await waitFor(() =>
      expect(mockCreateAccount).toHaveBeenCalledWith({
        displayName: "Gamma",
        password: "secret",
      })
    )
  })

  it("renames the selected account", async () => {
    renderDialog()
    fireEvent.click(screen.getByTestId("account-manage-row-acct_beta"))
    fireEvent.change(screen.getByLabelText("editDisplayNameLabel"), {
      target: { value: "Renamed" },
    })
    fireEvent.click(screen.getByRole("button", { name: "save" }))

    await waitFor(() => expect(mockRenameAccount).toHaveBeenCalledWith("acct_beta", "Renamed"))
  })

  it("deletes an inactive account after confirmation", async () => {
    renderDialog()
    fireEvent.click(screen.getByTestId("account-manage-row-acct_beta"))
    fireEvent.click(screen.getByRole("button", { name: "delete" }))
    fireEvent.click(screen.getByRole("button", { name: "confirmDelete" }))

    await waitFor(() =>
      expect(mockDeleteAccount).toHaveBeenCalledWith("acct_beta", {
        replacementAccountId: undefined,
      })
    )
  })

  it("deletes the active account with a replacement account id", async () => {
    renderDialog()
    fireEvent.click(screen.getByTestId("account-manage-row-acct_alpha"))
    fireEvent.click(screen.getByRole("button", { name: "delete" }))
    fireEvent.click(screen.getByRole("button", { name: "confirmDelete" }))

    await waitFor(() =>
      expect(mockDeleteAccount).toHaveBeenCalledWith("acct_alpha", {
        replacementAccountId: "acct_beta",
      })
    )
  })

  it("disables deleting the last account", () => {
    setManageState({ accounts: [account("acct_solo", "Solo")], activeAccountId: "acct_solo" })
    renderDialog()
    expect(screen.getByRole("button", { name: "delete" })).toBeDisabled()
  })

  it("shows action errors", async () => {
    mockCreateAccount.mockRejectedValueOnce(new Error("create failed"))
    renderDialog()
    fireEvent.change(screen.getByLabelText("newDisplayNameLabel"), {
      target: { value: "Gamma" },
    })
    fireEvent.change(screen.getByLabelText("newPasswordLabel"), {
      target: { value: "secret" },
    })
    fireEvent.click(screen.getByRole("button", { name: "createAccount" }))

    await screen.findByText("create failed")
  })

  it("shows rename and delete errors using string/fallback messages", async () => {
    mockRenameAccount.mockRejectedValueOnce("rename failed")
    renderDialog()
    fireEvent.click(screen.getByTestId("account-manage-row-acct_beta"))
    fireEvent.click(screen.getByRole("button", { name: "save" }))
    expect(await screen.findByText("rename failed")).toBeInTheDocument()

    mockDeleteAccount.mockRejectedValueOnce({ code: "delete-failed" })
    fireEvent.click(screen.getByRole("button", { name: "delete" }))
    fireEvent.click(screen.getByRole("button", { name: "confirmDelete" }))
    expect(await screen.findByText("operationFailed")).toBeInTheDocument()
  })

  it("renders the empty selection state when the account list is empty", () => {
    setManageState({ accounts: [], activeAccountId: null })
    renderDialog()
    expect(screen.getByText("empty")).toBeInTheDocument()
  })
})
