/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const saveMock = jest.fn()
let mockedSettings: Record<string, unknown> = {}

jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T,>(
    selector: (s: { settings: typeof mockedSettings; save: typeof saveMock }) => T
  ) => selector({ settings: mockedSettings, save: saveMock }),
}))

let mockedAccountState: {
  accounts: Array<Record<string, unknown>>
  unlockedAccountId: string | null
} = { accounts: [], unlockedAccountId: null }

jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: <T,>(selector: (s: typeof mockedAccountState) => T) =>
    selector(mockedAccountState),
}))

import { DESKTOP_LOCAL_ACCOUNT_ID } from "@/lib/accounts/desktop-local-account"

import { AUTO_LOCK_OPTIONS, AutoLockControl } from "./auto-lock-control"

beforeEach(() => {
  saveMock.mockReset()
  mockedSettings = {}
  mockedAccountState = { accounts: [], unlockedAccountId: null }
})

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
})

describe("AutoLockControl", () => {
  it("defaults to Off and renders every interval option", () => {
    render(<AutoLockControl />)
    const select = screen.getByTestId("account-auto-lock-select") as HTMLSelectElement
    expect(select.value).toBe("0")
    expect(select.querySelectorAll("option")).toHaveLength(AUTO_LOCK_OPTIONS.length)
  })

  it("persists a chosen interval", () => {
    render(<AutoLockControl />)
    fireEvent.change(screen.getByTestId("account-auto-lock-select"), { target: { value: "15" } })
    expect(saveMock).toHaveBeenCalledWith({ accountAutoLockMinutes: 15 })
  })

  it("reflects the persisted interval", () => {
    mockedSettings = { accountAutoLockMinutes: 30 }
    render(<AutoLockControl />)
    expect((screen.getByTestId("account-auto-lock-select") as HTMLSelectElement).value).toBe("30")
  })

  it("is inert and says so for a desktop profile that opens without a prompt", () => {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    mockedSettings = { accountAutoLockMinutes: 30 }
    mockedAccountState = {
      accounts: [{ id: "acct_mine", rememberOnDevice: true }],
      unlockedAccountId: "acct_mine",
    }
    render(<AutoLockControl />)
    const select = screen.getByTestId("account-auto-lock-select") as HTMLSelectElement
    expect(select).toBeDisabled()
    // The stored interval is kept for when the profile asks for its password again.
    expect(select.value).toBe("30")
    expect(screen.getByText("autoLock.inertHelp")).toBeInTheDocument()
  })

  it("is inert for the device-managed desktop workspace", () => {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    mockedAccountState = {
      accounts: [{ id: DESKTOP_LOCAL_ACCOUNT_ID, protection: "device" }],
      unlockedAccountId: DESKTOP_LOCAL_ACCOUNT_ID,
    }
    render(<AutoLockControl />)
    expect(screen.getByTestId("account-auto-lock-select")).toBeDisabled()
  })

  it("stays live for a password profile, and for any profile in a browser", () => {
    mockedAccountState = {
      accounts: [{ id: "acct_mine", rememberOnDevice: true }],
      unlockedAccountId: "acct_mine",
    }
    render(<AutoLockControl />)
    expect(screen.getByTestId("account-auto-lock-select")).not.toBeDisabled()
    expect(screen.getByText("autoLock.help")).toBeInTheDocument()
  })
})
