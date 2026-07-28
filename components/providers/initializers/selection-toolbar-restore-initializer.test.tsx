/**
 * @jest-environment jsdom
 */
import { render, waitFor } from "@testing-library/react"

import { SelectionToolbarRestoreInitializer } from "./selection-toolbar-restore-initializer"

const getPrefMock = jest.fn()
jest.mock("@/lib/tauri/store", () => ({
  getPref: (...args: unknown[]) => getPrefMock(...args),
  setPref: jest.fn().mockResolvedValue(undefined),
}))

const startMock = jest.fn()
jest.mock("@/lib/tauri/selection-toolbar", () => ({
  SELECTION_TOOLBAR_ENABLED_PREF: "selectionToolbar.enabled",
  SELECTION_TOOLBAR_DISABLED_APPS_PREF: "selectionToolbar.disabledApps",
  startSelectionToolbar: (...args: unknown[]) => startMock(...args),
}))

beforeEach(() => {
  jest.clearAllMocks()
  startMock.mockResolvedValue({ running: true, hasCandidate: false })
})

it("restores an enabled toolbar with its disabled app list", async () => {
  getPrefMock.mockImplementation(async (key: string) =>
    key === "selectionToolbar.enabled" ? true : ["1Password"]
  )
  render(<SelectionToolbarRestoreInitializer />)

  await waitFor(() => expect(startMock).toHaveBeenCalledWith(["1Password"]))
})

it("does not install the native monitor when the feature is disabled", async () => {
  getPrefMock.mockResolvedValue(false)
  render(<SelectionToolbarRestoreInitializer />)

  await waitFor(() => expect(getPrefMock).toHaveBeenCalledTimes(2))
  expect(startMock).not.toHaveBeenCalled()
})
