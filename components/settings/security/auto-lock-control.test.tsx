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

import { AUTO_LOCK_OPTIONS, AutoLockControl } from "./auto-lock-control"

beforeEach(() => {
  saveMock.mockReset()
  mockedSettings = {}
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
})
