/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { LocalAccountRecord } from "@/lib/accounts/account-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const deleteAccountMock = jest.fn<Promise<void>, [string, unknown?]>()
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: (selector: (s: { deleteAccount: typeof deleteAccountMock }) => unknown) =>
    selector({ deleteAccount: deleteAccountMock }),
}))

const toastMock = jest.fn(() => "toast-id")
const toastErrorMock = jest.fn()
const toastDismissMock = jest.fn()
jest.mock("sonner", () => ({
  toast: Object.assign((...args: unknown[]) => toastMock(...(args as [])), {
    error: (...args: unknown[]) => toastErrorMock(...(args as [])),
    dismiss: (...args: unknown[]) => toastDismissMock(...(args as [])),
  }),
}))

import { AccountDangerTab } from "./account-danger-tab"

const UNDO_WINDOW_MS = 8000

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
  jest.useFakeTimers()
})

afterEach(() => {
  jest.runOnlyPendingTimers()
  jest.useRealTimers()
})

function armAndType(name: string) {
  fireEvent.click(screen.getByTestId("account-danger-delete")) // idle → confirming
  fireEvent.change(screen.getByTestId("account-danger-confirm-input"), {
    target: { value: name },
  })
}

describe("AccountDangerTab", () => {
  it("keeps the confirm button disabled until the typed name matches", () => {
    render(
      <AccountDangerTab account={beta} accounts={[alpha, beta]} activeAccountId="acct_alpha" />
    )
    fireEvent.click(screen.getByTestId("account-danger-delete"))
    const confirm = screen.getByTestId("account-danger-delete")
    expect(confirm).toBeDisabled()
    fireEvent.change(screen.getByTestId("account-danger-confirm-input"), {
      target: { value: "Wrong" },
    })
    expect(confirm).toBeDisabled()
    fireEvent.change(screen.getByTestId("account-danger-confirm-input"), {
      target: { value: "Beta" },
    })
    expect(confirm).toBeEnabled()
  })

  it("schedules an inactive account and commits after the undo window", () => {
    render(
      <AccountDangerTab account={beta} accounts={[alpha, beta]} activeAccountId="acct_alpha" />
    )
    armAndType("Beta")
    fireEvent.click(screen.getByTestId("account-danger-delete"))
    // Not deleted yet — only scheduled.
    expect(deleteAccountMock).not.toHaveBeenCalled()
    expect(toastMock).toHaveBeenCalledTimes(1)
    act(() => {
      jest.advanceTimersByTime(UNDO_WINDOW_MS)
    })
    expect(deleteAccountMock).toHaveBeenCalledWith("acct_beta", { replacementAccountId: undefined })
  })

  it("commits the active account with a replacement after the window", () => {
    render(
      <AccountDangerTab account={alpha} accounts={[alpha, beta]} activeAccountId="acct_alpha" />
    )
    armAndType("Alpha")
    fireEvent.click(screen.getByTestId("account-danger-delete"))
    act(() => {
      jest.advanceTimersByTime(UNDO_WINDOW_MS)
    })
    expect(deleteAccountMock).toHaveBeenCalledWith("acct_alpha", {
      replacementAccountId: "acct_beta",
    })
  })

  it("undo cancels the scheduled deletion", () => {
    render(
      <AccountDangerTab account={beta} accounts={[alpha, beta]} activeAccountId="acct_alpha" />
    )
    armAndType("Beta")
    fireEvent.click(screen.getByTestId("account-danger-delete"))
    fireEvent.click(screen.getByTestId("account-danger-undo"))
    expect(toastDismissMock).toHaveBeenCalledWith("toast-id")
    act(() => {
      jest.advanceTimersByTime(UNDO_WINDOW_MS)
    })
    expect(deleteAccountMock).not.toHaveBeenCalled()
    // Back to the idle Delete button.
    expect(screen.getByTestId("account-danger-delete")).toBeEnabled()
  })

  it("cancels via the toast action even after the tab unmounts", () => {
    const { unmount } = render(
      <AccountDangerTab account={beta} accounts={[alpha, beta]} activeAccountId="acct_alpha" />
    )
    armAndType("Beta")
    fireEvent.click(screen.getByTestId("account-danger-delete"))
    const toastOptions = toastMock.mock.calls[0]?.[1] as { action: { onClick: () => void } }
    unmount()
    act(() => {
      toastOptions.action.onClick()
    })
    act(() => {
      jest.advanceTimersByTime(UNDO_WINDOW_MS)
    })
    expect(deleteAccountMock).not.toHaveBeenCalled()
  })

  it("disables deletion of the last account", () => {
    render(<AccountDangerTab account={alpha} accounts={[alpha]} activeAccountId="acct_alpha" />)
    expect(screen.getByTestId("account-danger-delete")).toBeDisabled()
    expect(screen.getByText("deleteBlockedLast")).toBeInTheDocument()
  })

  it("surfaces a commit failure via a toast", async () => {
    deleteAccountMock.mockRejectedValueOnce(new Error("delete failed"))
    render(
      <AccountDangerTab account={beta} accounts={[alpha, beta]} activeAccountId="acct_alpha" />
    )
    armAndType("Beta")
    fireEvent.click(screen.getByTestId("account-danger-delete"))
    await act(async () => {
      jest.advanceTimersByTime(UNDO_WINDOW_MS)
    })
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith("delete failed"))
  })

  it("surfaces a string commit failure verbatim", async () => {
    deleteAccountMock.mockRejectedValueOnce("string boom")
    render(
      <AccountDangerTab account={beta} accounts={[alpha, beta]} activeAccountId="acct_alpha" />
    )
    armAndType("Beta")
    fireEvent.click(screen.getByTestId("account-danger-delete"))
    await act(async () => {
      jest.advanceTimersByTime(UNDO_WINDOW_MS)
    })
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith("string boom"))
  })

  it("falls back to a generic message for a non-error commit failure", async () => {
    deleteAccountMock.mockRejectedValueOnce({ code: "x" })
    render(
      <AccountDangerTab account={beta} accounts={[alpha, beta]} activeAccountId="acct_alpha" />
    )
    armAndType("Beta")
    fireEvent.click(screen.getByTestId("account-danger-delete"))
    await act(async () => {
      jest.advanceTimersByTime(UNDO_WINDOW_MS)
    })
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith("operationFailed"))
  })
})
