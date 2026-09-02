/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { LocalAccountRecord } from "@/lib/accounts/account-types"
import type { AccountSwitchController } from "./use-account-switch"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  // The lock-screen backdrop formats its clock and date through next-intl.
  useFormatter: () => ({ dateTime: (value: Date) => value.toISOString() }),
}))

const beginMock = jest.fn<Promise<boolean>, [string]>()
const confirmMock = jest.fn<Promise<boolean>, []>()
const cancelMock = jest.fn<void, []>()
const setPasswordMock = jest.fn<void, [string]>()
let controller: AccountSwitchController
jest.mock("./use-account-switch", () => ({
  useAccountSwitch: () => controller,
}))

jest.mock("./account-profile-tab", () => ({
  AccountProfileTab: () => <div data-testid="profile-tab" />,
}))
jest.mock("./account-security-tab", () => ({
  AccountSecurityTab: () => <div data-testid="security-tab" />,
}))
jest.mock("./account-danger-tab", () => ({
  AccountDangerTab: () => <div data-testid="danger-tab" />,
}))

import { AccountDetail } from "./account-detail"

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
  beginMock.mockResolvedValue(false)
  confirmMock.mockResolvedValue(true)
  controller = {
    pendingId: null,
    password: "",
    setPassword: setPasswordMock,
    error: null,
    submitting: false,
    begin: beginMock,
    confirm: confirmMock,
    cancel: cancelMock,
  }
})

function renderDetail(props: Partial<React.ComponentProps<typeof AccountDetail>> = {}) {
  return render(
    <AccountDetail
      account={alpha}
      accounts={[alpha, beta]}
      activeAccountId="acct_alpha"
      unlockedAccountId="acct_alpha"
      {...props}
    />
  )
}

describe("AccountDetail", () => {
  it("renders the empty state without an account", () => {
    render(
      <AccountDetail account={null} accounts={[]} activeAccountId={null} unlockedAccountId={null} />
    )
    expect(screen.getByTestId("account-detail-empty")).toBeInTheDocument()
  })

  it("marks the active account and hides the switch button", () => {
    renderDetail()
    expect(screen.getByTestId("account-detail-active")).toBeInTheDocument()
    expect(screen.queryByTestId("account-detail-switch")).not.toBeInTheDocument()
  })

  it("offers a switch action for a non-active account", () => {
    renderDetail({ account: beta })
    fireEvent.click(screen.getByTestId("account-detail-switch"))
    expect(beginMock).toHaveBeenCalledWith("acct_beta")
  })

  it("shows the password prompt when a switch is pending and confirms it", () => {
    controller.pendingId = "acct_beta"
    renderDetail({ account: beta })
    expect(screen.queryByTestId("account-detail-switch")).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText("switchPasswordLabel"), { target: { value: "pw" } })
    expect(setPasswordMock).toHaveBeenCalledWith("pw")
    fireEvent.click(screen.getByRole("button", { name: "confirmSwitch" }))
    expect(confirmMock).toHaveBeenCalledTimes(1)
  })

  it("surfaces switch errors", () => {
    controller.pendingId = "acct_beta"
    controller.error = "bad password"
    renderDetail({ account: beta })
    expect(screen.getByText("bad password")).toBeInTheDocument()
  })

  it("renders the profile tab by default and switches to security", async () => {
    const user = userEvent.setup()
    renderDetail()
    expect(screen.getByTestId("profile-tab")).toBeInTheDocument()
    await user.click(screen.getByTestId("account-tab-security"))
    expect(screen.getByTestId("security-tab")).toBeInTheDocument()
  })

  it("renders a back button when showBack is set", () => {
    renderDetail({ showBack: true, onBack: jest.fn() })
    expect(screen.getByTestId("account-detail-back")).toBeInTheDocument()
  })
})
