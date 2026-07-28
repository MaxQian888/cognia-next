/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import { SelectionToolbarSettings } from "./selection-toolbar-settings"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const getPrefMock = jest.fn()
const setPrefMock = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/tauri/store", () => ({
  getPref: (...args: unknown[]) => getPrefMock(...args),
  setPref: (...args: unknown[]) => setPrefMock(...args),
}))

const startMock = jest.fn()
const stopMock = jest.fn()
jest.mock("@/lib/tauri/selection-toolbar", () => ({
  SELECTION_TOOLBAR_ENABLED_PREF: "selectionToolbar.enabled",
  SELECTION_TOOLBAR_DISABLED_APPS_PREF: "selectionToolbar.disabledApps",
  startSelectionToolbar: (...args: unknown[]) => startMock(...args),
  stopSelectionToolbar: () => stopMock(),
}))

const toastErrorMock = jest.fn()
jest.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => toastErrorMock(...args) },
}))

beforeEach(() => {
  jest.clearAllMocks()
  getPrefMock.mockImplementation(async (key: string) => {
    if (key === "selectionToolbar.enabled") return false
    if (key === "selectionToolbar.disabledApps") return ["1Password"]
    return null
  })
  startMock.mockResolvedValue({ running: true, hasCandidate: false })
  stopMock.mockResolvedValue({ running: false, hasCandidate: false })
})

it("loads the disabled app list and starts only after explicit opt-in", async () => {
  render(<SelectionToolbarSettings />)
  expect(await screen.findByDisplayValue("1Password")).toBeInTheDocument()

  fireEvent.click(screen.getByRole("switch", { name: "toggle" }))

  await waitFor(() => expect(startMock).toHaveBeenCalledWith(["1Password"]))
  expect(setPrefMock).toHaveBeenCalledWith("selectionToolbar.enabled", true)
})

it("persists the normalized disabled app list", async () => {
  render(<SelectionToolbarSettings />)
  const input = await screen.findByDisplayValue("1Password")
  fireEvent.change(input, { target: { value: " 1Password\nAuthy\n1Password " } })
  fireEvent.click(screen.getByRole("button", { name: "saveDisabledApps" }))

  await waitFor(() =>
    expect(setPrefMock).toHaveBeenCalledWith("selectionToolbar.disabledApps", [
      "1Password",
      "Authy",
    ])
  )
})

it("keeps the toggle off and reports a permission failure", async () => {
  startMock.mockRejectedValueOnce(new Error("accessibility permission denied"))
  render(<SelectionToolbarSettings />)
  await screen.findByDisplayValue("1Password")

  fireEvent.click(screen.getByRole("switch", { name: "toggle" }))

  await waitFor(() => expect(toastErrorMock).toHaveBeenCalled())
  expect(setPrefMock).toHaveBeenCalledWith("selectionToolbar.enabled", false)
  expect(screen.getByRole("switch", { name: "toggle" })).not.toBeChecked()
})
