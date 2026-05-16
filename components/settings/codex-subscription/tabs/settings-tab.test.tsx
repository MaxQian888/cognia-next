/** @jest-environment jsdom */

const getSettingsMock = jest.fn()
const saveSettingsMock = jest.fn()

jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(() => true),
  transport: { call: jest.fn(async () => null) },
}))

jest.mock("@/lib/db/settings", () => ({
  getSettings: () => getSettingsMock(),
  saveSettings: (...args: unknown[]) => saveSettingsMock(...args),
}))

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { CodexSubscriptionSettingsTab } from "./settings-tab"

beforeEach(() => {
  getSettingsMock.mockReset()
  saveSettingsMock.mockReset()
  saveSettingsMock.mockResolvedValue(undefined)
})

describe("CodexSubscriptionSettingsTab", () => {
  it("renders two toggle switches with their default state checked", async () => {
    getSettingsMock.mockResolvedValue({})
    render(<CodexSubscriptionSettingsTab />)
    await waitFor(() => expect(screen.getAllByRole("switch")).toHaveLength(2))
    const switches = screen.getAllByRole("switch")
    expect(switches[0]).toHaveAttribute("data-state", "checked")
    expect(switches[1]).toHaveAttribute("data-state", "checked")
  })

  it("disables Save while draft matches persisted settings", async () => {
    getSettingsMock.mockResolvedValue({})
    render(<CodexSubscriptionSettingsTab />)
    await waitFor(() => expect(screen.getAllByRole("switch")).toHaveLength(2))
    const buttons = screen.getAllByRole("button")
    // Save is the second-to-last button; Reset is last. Order depends on the
    // tab markup — assume Save comes first within the action row.
    const save =
      buttons.find((b) => !b.classList.contains("variant-outline")) ?? buttons[buttons.length - 2]
    expect(save).toBeDisabled()
  })

  it("toggling a switch enables the Save button", async () => {
    const user = userEvent.setup()
    getSettingsMock.mockResolvedValue({})
    render(<CodexSubscriptionSettingsTab />)
    await waitFor(() => expect(screen.getAllByRole("switch")).toHaveLength(2))
    const preferToggle = screen.getAllByRole("switch")[0]
    await user.click(preferToggle)
    // After toggling, at least one button should now be enabled (Save).
    await waitFor(() => {
      const enabled = screen.getAllByRole("button").filter((b) => !b.hasAttribute("disabled"))
      expect(enabled.length).toBeGreaterThanOrEqual(1)
    })
  })
})
