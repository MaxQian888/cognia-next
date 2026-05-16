/** @jest-environment jsdom */

jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(() => true),
  transport: { call: jest.fn(async () => null) },
}))

const saveMock = jest.fn(async () => undefined)

jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: jest.fn(),
}))

import { render, screen } from "@testing-library/react"

import { DEFAULT_SUBSCRIPTION_SETTINGS } from "@/lib/anthropic-subscription/types"
import { useSettingsStore } from "@/stores/settings/settings-store"

import { SubscriptionSettingsTab } from "./settings-tab"

const mUseSettingsStore = useSettingsStore as unknown as jest.Mock

beforeEach(() => {
  saveMock.mockClear()
  mUseSettingsStore.mockReset()
  mUseSettingsStore.mockImplementation((selector: (s: unknown) => unknown) =>
    selector({
      settings: { subscriptionSettings: { ...DEFAULT_SUBSCRIPTION_SETTINGS } },
      save: saveMock,
    })
  )
})

describe("SubscriptionSettingsTab", () => {
  it("renders both Save and Reset buttons", () => {
    render(<SubscriptionSettingsTab />)
    const buttons = screen.getAllByRole("button")
    expect(buttons.length).toBeGreaterThanOrEqual(2)
  })

  it("Save button is disabled while draft matches persisted settings", () => {
    render(<SubscriptionSettingsTab />)
    // Save is the last button rendered (Reset comes first in the footer
    // because of `justify-end` + `Reset` then `Save`).
    const buttons = screen.getAllByRole("button")
    const save = buttons[buttons.length - 1]
    expect(save).toBeDisabled()
  })

  it("renders the probe switch in unchecked default state", () => {
    render(<SubscriptionSettingsTab />)
    const probeSwitch = screen.getAllByRole("switch")[0]
    expect(probeSwitch).toHaveAttribute("data-state", "unchecked")
  })
})
