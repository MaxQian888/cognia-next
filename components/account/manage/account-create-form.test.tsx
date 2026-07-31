/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { LocalAccountRecord } from "@/lib/accounts/account-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, string>) =>
    values ? `${key}:${Object.values(values).join(",")}` : key,
}))

const createAccountMock = jest.fn<Promise<LocalAccountRecord>, [unknown]>()
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: (selector: (s: { createAccount: typeof createAccountMock }) => unknown) =>
    selector({ createAccount: createAccountMock }),
}))

import { AccountCreateForm } from "./account-create-form"

const account: LocalAccountRecord = {
  id: "acct_new",
  displayName: "New",
  passwordVerifier: { algorithm: "a", salt: "s", hash: "h", params: {} },
  createdAt: 1,
  updatedAt: 1,
}

beforeEach(() => {
  jest.clearAllMocks()
  createAccountMock.mockResolvedValue(account)
})

describe("AccountCreateForm", () => {
  it("expands, creates an account, then collapses", async () => {
    const onCreated = jest.fn()
    render(<AccountCreateForm onCreated={onCreated} />)
    fireEvent.click(screen.getByTestId("account-create-toggle"))
    fireEvent.change(screen.getByLabelText("newDisplayNameLabel"), { target: { value: "Gamma" } })
    fireEvent.change(screen.getByLabelText("newPasswordLabel"), { target: { value: "secret-pw" } })
    fireEvent.click(screen.getByRole("button", { name: "createAccount" }))

    await waitFor(() =>
      expect(createAccountMock).toHaveBeenCalledWith({
        displayName: "Gamma",
        password: "secret-pw",
      })
    )
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(account))
    expect(screen.getByTestId("account-create-toggle")).toBeInTheDocument()
  })

  it("blocks a too-short password", () => {
    render(<AccountCreateForm />)
    fireEvent.click(screen.getByTestId("account-create-toggle"))
    fireEvent.change(screen.getByLabelText("newPasswordLabel"), { target: { value: "short" } })
    fireEvent.click(screen.getByRole("button", { name: "createAccount" }))
    expect(screen.getByText("passwordTooShort:8")).toBeInTheDocument()
    expect(createAccountMock).not.toHaveBeenCalled()
  })

  it("surfaces creation errors", async () => {
    createAccountMock.mockRejectedValueOnce(new Error("create failed"))
    render(<AccountCreateForm />)
    fireEvent.click(screen.getByTestId("account-create-toggle"))
    fireEvent.change(screen.getByLabelText("newPasswordLabel"), { target: { value: "secret-pw" } })
    fireEvent.click(screen.getByRole("button", { name: "createAccount" }))
    expect(await screen.findByText("create failed")).toBeInTheDocument()
  })

  it("shows string and fallback creation errors", async () => {
    createAccountMock.mockRejectedValueOnce("string boom")
    render(<AccountCreateForm />)
    fireEvent.click(screen.getByTestId("account-create-toggle"))
    fireEvent.change(screen.getByLabelText("newPasswordLabel"), { target: { value: "secret-pw" } })
    fireEvent.click(screen.getByRole("button", { name: "createAccount" }))
    expect(await screen.findByText("string boom")).toBeInTheDocument()

    createAccountMock.mockRejectedValueOnce({ code: "x" })
    fireEvent.click(screen.getByRole("button", { name: "createAccount" }))
    expect(await screen.findByText("operationFailed")).toBeInTheDocument()
  })

  it("cancels back to the toggle without submitting", () => {
    render(<AccountCreateForm />)
    fireEvent.click(screen.getByTestId("account-create-toggle"))
    fireEvent.click(screen.getByRole("button", { name: "cancel" }))
    expect(screen.getByTestId("account-create-toggle")).toBeInTheDocument()
    expect(screen.queryByLabelText("newDisplayNameLabel")).not.toBeInTheDocument()
    expect(createAccountMock).not.toHaveBeenCalled()
  })
})
