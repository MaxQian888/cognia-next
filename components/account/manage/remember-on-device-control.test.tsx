/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { LocalAccountRecord } from "@/lib/accounts/account-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const setRememberOnDeviceMock = jest.fn<
  Promise<LocalAccountRecord>,
  [string, boolean, string | undefined]
>()
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: (selector: (state: { setRememberOnDevice: unknown }) => unknown) =>
    selector({ setRememberOnDevice: setRememberOnDeviceMock }),
}))

import { RememberOnDeviceControl } from "./remember-on-device-control"

const account: LocalAccountRecord = {
  id: "acct_a",
  displayName: "Alpha",
  passwordVerifier: { algorithm: "a", salt: "s", hash: "h", params: {} },
  createdAt: 1,
  updatedAt: 1,
}

beforeEach(() => {
  jest.clearAllMocks()
  setRememberOnDeviceMock.mockImplementation(async (id, enabled) => ({
    ...account,
    id,
    ...(enabled ? { rememberOnDevice: true } : {}),
  }))
})

describe("RememberOnDeviceControl", () => {
  it("shows the current state of a profile that has not opted in", () => {
    render(<RememberOnDeviceControl account={account} />)
    expect(screen.getByTestId("account-remember-on-device-switch")).not.toBeChecked()
    expect(screen.getByText("rememberOnDeviceOffHelp")).toBeInTheDocument()
  })

  it("asks for the password before turning it on, and sends it", async () => {
    render(<RememberOnDeviceControl account={account} />)

    fireEvent.click(screen.getByTestId("account-remember-on-device-switch"))
    expect(setRememberOnDeviceMock).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText("rememberOnDevicePasswordLabel"), {
      target: { value: "hunter22" },
    })
    fireEvent.click(screen.getByTestId("account-remember-on-device-confirm"))

    await waitFor(() =>
      expect(setRememberOnDeviceMock).toHaveBeenCalledWith("acct_a", true, "hunter22")
    )
    await waitFor(() =>
      expect(screen.queryByLabelText("rememberOnDevicePasswordLabel")).not.toBeInTheDocument()
    )
  })

  it("refuses to submit an empty password", () => {
    render(<RememberOnDeviceControl account={account} />)
    fireEvent.click(screen.getByTestId("account-remember-on-device-switch"))
    fireEvent.click(screen.getByTestId("account-remember-on-device-confirm"))
    expect(screen.getByRole("alert")).toHaveTextContent("rememberOnDevicePasswordRequired")
    expect(setRememberOnDeviceMock).not.toHaveBeenCalled()
  })

  it("shows the store's refusal and keeps the confirmation open", async () => {
    setRememberOnDeviceMock.mockRejectedValue(new Error("Invalid local account password."))
    render(<RememberOnDeviceControl account={account} />)
    fireEvent.click(screen.getByTestId("account-remember-on-device-switch"))
    fireEvent.change(screen.getByLabelText("rememberOnDevicePasswordLabel"), {
      target: { value: "wrong" },
    })
    fireEvent.click(screen.getByTestId("account-remember-on-device-confirm"))

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Invalid local account password.")
    )
    expect(screen.getByLabelText("rememberOnDevicePasswordLabel")).toBeInTheDocument()
  })

  it("cancelling leaves the option off and sends nothing", () => {
    render(<RememberOnDeviceControl account={account} />)
    fireEvent.click(screen.getByTestId("account-remember-on-device-switch"))
    fireEvent.click(screen.getByRole("button", { name: "cancel" }))
    expect(screen.queryByLabelText("rememberOnDevicePasswordLabel")).not.toBeInTheDocument()
    expect(screen.getByTestId("account-remember-on-device-switch")).not.toBeChecked()
    expect(setRememberOnDeviceMock).not.toHaveBeenCalled()
  })

  it("turns it off at once, without a password", async () => {
    render(<RememberOnDeviceControl account={{ ...account, rememberOnDevice: true }} />)
    const toggle = screen.getByTestId("account-remember-on-device-switch")
    expect(toggle).toBeChecked()
    expect(screen.getByText("rememberOnDeviceOnHelp")).toBeInTheDocument()

    fireEvent.click(toggle)

    await waitFor(() => expect(setRememberOnDeviceMock).toHaveBeenCalledWith("acct_a", false))
    expect(screen.queryByLabelText("rememberOnDevicePasswordLabel")).not.toBeInTheDocument()
  })
})
