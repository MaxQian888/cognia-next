/**
 * @jest-environment jsdom
 */
import { render, waitFor } from "@testing-library/react"

import { SelectionToolbarRestoreInitializer } from "./selection-toolbar-restore-initializer"

const ensureBootCapabilityMock = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/boot/capabilities", () => ({
  ensureBootCapability: (...args: unknown[]) => ensureBootCapabilityMock(...args),
}))

const getPrefMock = jest.fn()
jest.mock("@/lib/tauri/store", () => ({
  getPref: (...args: unknown[]) => getPrefMock(...args),
  setPref: jest.fn().mockResolvedValue(undefined),
}))

const startMock = jest.fn()
jest.mock("@/lib/tauri/selection-toolbar", () => ({
  SELECTION_TOOLBAR_ENABLED_PREF: "selectionToolbar.enabled",
  SELECTION_TOOLBAR_MODE_PREF: "selectionToolbar.mode",
  SELECTION_TOOLBAR_DISABLED_APPS_PREF: "selectionToolbar.disabledApps",
  SELECTION_TOOLBAR_DISABLED_SITES_PREF: "selectionToolbar.disabledSites",
  startSelectionToolbar: (...args: unknown[]) => startMock(...args),
}))

beforeEach(() => {
  jest.clearAllMocks()
  startMock.mockResolvedValue({ running: true, hasCandidate: false })
})

it("restores an enabled toolbar with its disabled app list", async () => {
  getPrefMock.mockImplementation(async (key: string) => {
    if (key === "selectionToolbar.enabled") return true
    if (key === "selectionToolbar.disabledApps") return ["1Password"]
    if (key === "selectionToolbar.disabledSites") return ["accounts.example.com"]
    return null
  })
  render(<SelectionToolbarRestoreInitializer />)

  await waitFor(() =>
    expect(startMock).toHaveBeenCalledWith({
      mode: "automatic",
      disabledApps: ["1Password"],
      disabledSites: ["accounts.example.com"],
    })
  )
  expect(ensureBootCapabilityMock).toHaveBeenCalledWith("desktop-tools")
})

it("restores manual mode without migrating it back to automatic", async () => {
  getPrefMock.mockImplementation(async (key: string) => {
    if (key === "selectionToolbar.mode") return "manual"
    if (key === "selectionToolbar.enabled") return false
    return []
  })
  render(<SelectionToolbarRestoreInitializer />)

  await waitFor(() =>
    expect(startMock).toHaveBeenCalledWith({ mode: "manual", disabledApps: [], disabledSites: [] })
  )
})

it("does not install the native monitor when the feature is disabled", async () => {
  getPrefMock.mockResolvedValue(false)
  render(<SelectionToolbarRestoreInitializer />)

  await waitFor(() => expect(getPrefMock).toHaveBeenCalledTimes(4))
  expect(startMock).not.toHaveBeenCalled()
})
