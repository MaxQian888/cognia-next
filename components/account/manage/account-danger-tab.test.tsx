/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { LocalAccountRecord } from "@/lib/accounts/account-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const deleteAccountMock = jest.fn<Promise<void>, [string, unknown?]>()
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: (selector: (s: { deleteAccount: typeof deleteAccountMock }) => unknown) =>
    selector({ deleteAccount: deleteAccountMock }),
}))

import { AccountDangerTab } from "./account-danger-tab"

function account(id: string, displayName: string): LocalAccountRecord {
  return {
    id,
    displayName,
    passwordVerifier: { algorithm: "a", salt: "s", hash: "h", params: {} },
    createdAt: 1,
    updatedAt: 1,
  }
}

const alpha = account("acct_alpha", "Alpha")
const beta = account("acct_beta", "Beta")

beforeEach(() => {
  jest.clearAllMocks()
  deleteAccountMock.mockResolvedValue()
})

describe("AccountDangerTab", () => {
  it("two-step deletes an inactive account", async () => {
    render(
      <AccountDangerTab account={beta} accounts={[alpha, beta]} activeAccountId="acct_alpha" />
    )
    const button = screen.getByTestId("account-danger-delete")
    fireEvent.click(button) // arm
    fireEvent.click(button) // confirm
    await waitFor(() =>
      expect(deleteAccountMock).toHaveBeenCalledWith("acct_beta", {
        replacementAccountId: undefined,
      })
    )
  })

  it("deletes the active account with a replacement id", async () => {
    render(
      <AccountDangerTab account={alpha} accounts={[alpha, beta]} activeAccountId="acct_alpha" />
    )
    const button = screen.getByTestId("account-danger-delete")
    fireEvent.click(button)
    fireEvent.click(button)
    await waitFor(() =>
      expect(deleteAccountMock).toHaveBeenCalledWith("acct_alpha", {
        replacementAccountId: "acct_beta",
      })
    )
  })

  it("disables deletion of the last account", () => {
    render(<AccountDangerTab account={alpha} accounts={[alpha]} activeAccountId="acct_alpha" />)
    expect(screen.getByTestId("account-danger-delete")).toBeDisabled()
    expect(screen.getByText("deleteBlockedLast")).toBeInTheDocument()
  })

  it("surfaces delete errors", async () => {
    deleteAccountMock.mockRejectedValueOnce(new Error("delete failed"))
    render(
      <AccountDangerTab account={beta} accounts={[alpha, beta]} activeAccountId="acct_alpha" />
    )
    const button = screen.getByTestId("account-danger-delete")
    fireEvent.click(button)
    fireEvent.click(button)
    expect(await screen.findByText("delete failed")).toBeInTheDocument()
  })

  it("shows string and fallback delete errors", async () => {
    deleteAccountMock.mockRejectedValueOnce("string boom")
    render(
      <AccountDangerTab account={beta} accounts={[alpha, beta]} activeAccountId="acct_alpha" />
    )
    const button = screen.getByTestId("account-danger-delete")
    fireEvent.click(button) // arm
    fireEvent.click(button) // confirm → string error
    expect(await screen.findByText("string boom")).toBeInTheDocument()

    deleteAccountMock.mockRejectedValueOnce({ code: "x" })
    fireEvent.click(button) // still armed → confirm → object error
    expect(await screen.findByText("operationFailed")).toBeInTheDocument()
  })
})
