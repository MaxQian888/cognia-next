/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { DEFAULT_ANTHROPIC_SUBSCRIPTION_SETTINGS } from "@/types/subscription"

const saveMock = jest.fn(async () => {})
let settings: unknown = undefined
let tauri = true

jest.mock("@/lib/tauri", () => ({ isTauri: () => tauri }))
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: (selector: (state: { settings: unknown; save: typeof saveMock }) => unknown) =>
    selector({ settings, save: saveMock }),
}))
jest.mock("@/components/settings/subscription/custom-sources-card", () => ({
  CustomSourcesCard: () => null,
}))

import { SubscriptionSettingsTab } from "./settings-tab"

beforeEach(() => {
  jest.clearAllMocks()
  settings = undefined
  tauri = true
})

it("merges legacy stored settings with safe defaults and re-syncs external changes", () => {
  settings = {
    subscriptionSettings: {
      probeEnabled: true,
      visibleIntervalMs: 600_000,
      idleIntervalMs: 900_000,
      warnThresholdPct: 25,
    },
  }
  const { rerender } = render(<SubscriptionSettingsTab />)

  expect(screen.getByRole("switch", { name: "Enable active probe" })).toBeChecked()
  expect(screen.getByLabelText("Cadence when this page is visible (seconds)")).toHaveValue(600)
  expect(screen.getByLabelText("Warn at (%)")).toHaveValue(25)

  settings = {
    subscriptionSettings: {
      ...DEFAULT_ANTHROPIC_SUBSCRIPTION_SETTINGS,
      warnThresholdPct: 40,
    },
  }
  rerender(<SubscriptionSettingsTab />)

  expect(screen.getByLabelText("Warn at (%)")).toHaveValue(40)
})

it("clamps edited cadence and threshold values before saving", async () => {
  render(<SubscriptionSettingsTab />)

  fireEvent.click(screen.getByRole("switch", { name: "Enable active probe" }))
  fireEvent.change(screen.getByLabelText("Cadence when this page is visible (seconds)"), {
    target: { value: "1" },
  })
  fireEvent.change(screen.getByLabelText("Cadence when this page is hidden (seconds)"), {
    target: { value: "120" },
  })
  fireEvent.change(screen.getByLabelText("Warn at (%)"), { target: { value: "101.6" } })
  fireEvent.click(screen.getByRole("button", { name: "Save" }))

  expect(saveMock).toHaveBeenCalledWith({
    subscriptionSettings: {
      probeEnabled: true,
      visibleIntervalMs: 60_000,
      idleIntervalMs: 120_000,
      warnThresholdPct: 100,
    },
  })
})

it("resets an edited draft to conservative defaults", async () => {
  const user = userEvent.setup()
  settings = {
    subscriptionSettings: {
      ...DEFAULT_ANTHROPIC_SUBSCRIPTION_SETTINGS,
      probeEnabled: true,
      warnThresholdPct: 20,
    },
  }
  render(<SubscriptionSettingsTab />)

  await user.click(screen.getByRole("switch", { name: "Enable active probe" }))
  await user.click(screen.getByRole("button", { name: "Reset to defaults" }))

  expect(screen.getByRole("switch", { name: "Enable active probe" })).not.toBeChecked()
  expect(screen.getByLabelText("Warn at (%)")).toHaveValue(
    DEFAULT_ANTHROPIC_SUBSCRIPTION_SETTINGS.warnThresholdPct
  )
})

it("shows the desktop-only notice outside Tauri", () => {
  tauri = false

  render(<SubscriptionSettingsTab />)

  expect(
    screen.getAllByText(
      "Subscription credentials are stored in your OS keychain — only available in the desktop app."
    )
  ).toHaveLength(2)
  expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument()
})
