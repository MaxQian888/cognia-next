/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { LocalAccountRecord } from "@/lib/accounts/account-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, string>) =>
    values ? `${key}:${Object.values(values).join(",")}` : key,
}))

const changePasswordMock = jest.fn<Promise<LocalAccountRecord>, [string, string, string]>()
const lockMock = jest.fn<Promise<void>, []>()
let mockState: {
  changePassword: typeof changePasswordMock
  lock: typeof lockMock
  unlockedAccountId: string | null
}
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: (selector: (s: typeof mockState) => unknown) => selector(mockState),
}))

jest.mock("@/components/settings/security/auto-lock-control", () => ({
  AutoLockControl: () => <div data-testid="auto-lock-control" />,
}))

import { AccountSecurityTab } from "./account-security-tab"

const account: LocalAccountRecord = {
  id: "acct_a",
  displayName: "Alpha",
  passwordVerifier: { algorithm: "a", salt: "s", hash: "h", params: {} },
  createdAt: 1,
  updatedAt: 1,
}

const fillPasswords = (current: string, next: string, confirm: string) => {
  fireEvent.change(screen.getByLabelText("currentPasswordLabel"), { target: { value: current } })
  fireEvent.change(screen.getByLabelText("changeNewPasswordLabel"), { target: { value: next } })
  fireEvent.change(screen.getByLabelText("confirmNewPasswordLabel"), { target: { value: confirm } })
}

beforeEach(() => {
  jest.clearAllMocks()
  changePasswordMock.mockResolvedValue(account)
  lockMock.mockResolvedValue(undefined)
  mockState = { changePassword: changePasswordMock, lock: lockMock, unlockedAccountId: "acct_a" }
})

describe("AccountSecurityTab", () => {
  it("changes the password and confirms success", async () => {
    render(<AccountSecurityTab account={account} />)
    fillPasswords("old-password", "new-secret", "new-secret")
    fireEvent.click(screen.getByRole("button", { name: "changePassword" }))
    await waitFor(() =>
      expect(changePasswordMock).toHaveBeenCalledWith("acct_a", "old-password", "new-secret")
    )
    expect(await screen.findByText("passwordChanged")).toBeInTheDocument()
  })

  it("blocks a mismatched confirmation", () => {
    render(<AccountSecurityTab account={account} />)
    fillPasswords("old-password", "new-secret", "different")
    fireEvent.click(screen.getByRole("button", { name: "changePassword" }))
    expect(screen.getByText("passwordMismatch")).toBeInTheDocument()
    expect(changePasswordMock).not.toHaveBeenCalled()
  })

  it("blocks a too-short new password", () => {
    render(<AccountSecurityTab account={account} />)
    fillPasswords("old-password", "short", "short")
    fireEvent.click(screen.getByRole("button", { name: "changePassword" }))
    expect(screen.getByText("passwordTooShort:8")).toBeInTheDocument()
    expect(changePasswordMock).not.toHaveBeenCalled()
  })

  it("surfaces change-password errors", async () => {
    changePasswordMock.mockRejectedValueOnce(new Error("Invalid local account password."))
    render(<AccountSecurityTab account={account} />)
    fillPasswords("wrong", "new-secret", "new-secret")
    fireEvent.click(screen.getByRole("button", { name: "changePassword" }))
    expect(await screen.findByText("Invalid local account password.")).toBeInTheDocument()
  })

  it("shows string and fallback change errors", async () => {
    changePasswordMock.mockRejectedValueOnce("string boom")
    render(<AccountSecurityTab account={account} />)
    fillPasswords("old-password", "new-secret", "new-secret")
    fireEvent.click(screen.getByRole("button", { name: "changePassword" }))
    expect(await screen.findByText("string boom")).toBeInTheDocument()

    changePasswordMock.mockRejectedValueOnce({ code: "x" })
    fireEvent.click(screen.getByRole("button", { name: "changePassword" }))
    expect(await screen.findByText("operationFailed")).toBeInTheDocument()
  })

  it("locks the session immediately when unlocked", () => {
    render(<AccountSecurityTab account={account} />)
    const button = screen.getByTestId("account-security-lock-now")
    expect(button).not.toBeDisabled()
    fireEvent.click(button)
    expect(lockMock).toHaveBeenCalledTimes(1)
  })

  it("surfaces runtime-clear errors without reporting the account as locked", async () => {
    lockMock.mockRejectedValueOnce(new Error("sidecar is busy"))
    render(<AccountSecurityTab account={account} />)

    fireEvent.click(screen.getByTestId("account-security-lock-now"))

    expect(await screen.findByRole("alert")).toHaveTextContent("sidecar is busy")
  })

  it("disables Lock now when no session is unlocked", () => {
    mockState.unlockedAccountId = null
    render(<AccountSecurityTab account={account} />)
    expect(screen.getByTestId("account-security-lock-now")).toBeDisabled()
  })

  it("renders the shared auto-lock control", () => {
    render(<AccountSecurityTab account={account} />)
    expect(screen.getByTestId("auto-lock-control")).toBeInTheDocument()
  })
})
