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
const mockChangePassword = jest.fn<Promise<LocalAccountRecord>, [string, string, string]>()
const mockDeleteAccount = jest.fn<Promise<void>, [string, unknown?]>()

let mockState: Pick<
  AccountStoreState,
  | "accounts"
  | "activeAccountId"
  | "createAccount"
  | "renameAccount"
  | "changePassword"
  | "deleteAccount"
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
    changePassword: mockChangePassword,
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
  mockChangePassword.mockImplementation(async (id) => account(id, "Alpha"))
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
      target: { value: "secret-pw" },
    })
    fireEvent.click(screen.getByRole("button", { name: "createAccount" }))

    await waitFor(() =>
      expect(mockCreateAccount).toHaveBeenCalledWith({
        displayName: "Gamma",
        password: "secret-pw",
      })
    )
  })

  it("blocks creating an account below the minimum password length", () => {
    renderDialog()
    fireEvent.change(screen.getByLabelText("newDisplayNameLabel"), {
      target: { value: "Gamma" },
    })
    fireEvent.change(screen.getByLabelText("newPasswordLabel"), {
      target: { value: "short" },
    })
    fireEvent.click(screen.getByRole("button", { name: "createAccount" }))

    expect(screen.getByText("passwordTooShort:8")).toBeInTheDocument()
    expect(mockCreateAccount).not.toHaveBeenCalled()
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

  it("changes the password for the selected account", async () => {
    renderDialog()
    fireEvent.change(screen.getByLabelText("currentPasswordLabel"), {
      target: { value: "old-password" },
    })
    fireEvent.change(screen.getByLabelText("changeNewPasswordLabel"), {
      target: { value: "new-secret" },
    })
    fireEvent.change(screen.getByLabelText("confirmNewPasswordLabel"), {
      target: { value: "new-secret" },
    })
    fireEvent.click(screen.getByRole("button", { name: "changePassword" }))

    await waitFor(() =>
      expect(mockChangePassword).toHaveBeenCalledWith("acct_alpha", "old-password", "new-secret")
    )
    expect(await screen.findByText("passwordChanged")).toBeInTheDocument()
  })

  it("blocks the password change when the confirmation does not match", async () => {
    renderDialog()
    fireEvent.change(screen.getByLabelText("currentPasswordLabel"), {
      target: { value: "old-password" },
    })
    fireEvent.change(screen.getByLabelText("changeNewPasswordLabel"), {
      target: { value: "new-secret" },
    })
    fireEvent.change(screen.getByLabelText("confirmNewPasswordLabel"), {
      target: { value: "different" },
    })
    fireEvent.click(screen.getByRole("button", { name: "changePassword" }))

    expect(await screen.findByText("passwordMismatch")).toBeInTheDocument()
    expect(mockChangePassword).not.toHaveBeenCalled()
  })

  it("blocks the password change below the minimum length", () => {
    renderDialog()
    fireEvent.change(screen.getByLabelText("currentPasswordLabel"), {
      target: { value: "old-password" },
    })
    fireEvent.change(screen.getByLabelText("changeNewPasswordLabel"), {
      target: { value: "short" },
    })
    fireEvent.change(screen.getByLabelText("confirmNewPasswordLabel"), {
      target: { value: "short" },
    })
    fireEvent.click(screen.getByRole("button", { name: "changePassword" }))

    expect(screen.getByText("passwordTooShort:8")).toBeInTheDocument()
    expect(mockChangePassword).not.toHaveBeenCalled()
  })

  it("surfaces password change errors", async () => {
    mockChangePassword.mockRejectedValueOnce(new Error("Invalid local account password."))
    renderDialog()
    fireEvent.change(screen.getByLabelText("currentPasswordLabel"), {
      target: { value: "wrong" },
    })
    fireEvent.change(screen.getByLabelText("changeNewPasswordLabel"), {
      target: { value: "new-secret" },
    })
    fireEvent.change(screen.getByLabelText("confirmNewPasswordLabel"), {
      target: { value: "new-secret" },
    })
    fireEvent.click(screen.getByRole("button", { name: "changePassword" }))

    expect(await screen.findByText("Invalid local account password.")).toBeInTheDocument()
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
      target: { value: "secret-pw" },
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
