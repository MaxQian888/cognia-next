/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

import { SelectionToolbarSettings } from "./selection-toolbar-settings"

jest.mock("next-intl", () => ({
  useLocale: () => "en",
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
    if (key === "selectionToolbar.translateLocale") return "ja"
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

it("restores the saved translation target, which used to be reachable only from the popup", async () => {
  render(<SelectionToolbarSettings />)
  await screen.findByDisplayValue("1Password")
  expect(screen.getByRole("combobox")).toHaveTextContent("languages.ja")
})

it("persists a new translation target", async () => {
  render(<SelectionToolbarSettings />)
  await screen.findByDisplayValue("1Password")

  // Radix Select needs a keyboard-driven open in jsdom (no pointer geometry).
  const trigger = screen.getByRole("combobox")
  fireEvent.keyDown(trigger, { key: "Enter" })
  fireEvent.click(await screen.findByRole("option", { name: "languages.de" }))

  await waitFor(() =>
    expect(setPrefMock).toHaveBeenCalledWith("selectionToolbar.translateLocale", "de")
  )
})

it("stops the toolbar when switched back off", async () => {
  getPrefMock.mockImplementation(async (key: string) => {
    if (key === "selectionToolbar.enabled") return true
    if (key === "selectionToolbar.disabledApps") return ["1Password"]
    if (key === "selectionToolbar.translateLocale") return "ja"
    return null
  })
  render(<SelectionToolbarSettings />)
  await screen.findByDisplayValue("1Password")

  fireEvent.click(screen.getByRole("switch", { name: "toggle" }))

  await waitFor(() => expect(stopMock).toHaveBeenCalled())
  expect(setPrefMock).toHaveBeenCalledWith("selectionToolbar.enabled", false)
})

it("restarts a running toolbar so a new app block list takes effect at once", async () => {
  getPrefMock.mockImplementation(async (key: string) => {
    if (key === "selectionToolbar.enabled") return true
    if (key === "selectionToolbar.disabledApps") return ["1Password"]
    return null
  })
  render(<SelectionToolbarSettings />)
  const input = await screen.findByDisplayValue("1Password")
  fireEvent.change(input, { target: { value: "1Password\nKeePass" } })
  fireEvent.click(screen.getByRole("button", { name: "saveDisabledApps" }))

  await waitFor(() => expect(startMock).toHaveBeenCalledWith(["1Password", "KeePass"]))
})

it("reports a failure to restart without losing the saved list", async () => {
  getPrefMock.mockImplementation(async (key: string) => {
    if (key === "selectionToolbar.enabled") return true
    if (key === "selectionToolbar.disabledApps") return ["1Password"]
    return null
  })
  startMock.mockRejectedValueOnce(new Error("input monitoring revoked"))
  render(<SelectionToolbarSettings />)
  await screen.findByDisplayValue("1Password")
  fireEvent.click(screen.getByRole("button", { name: "saveDisabledApps" }))

  await waitFor(() => expect(toastErrorMock).toHaveBeenCalled())
  expect(setPrefMock).toHaveBeenCalledWith("selectionToolbar.disabledApps", ["1Password"])
})

it("stringifies a non-Error rejection from the restart path too", async () => {
  getPrefMock.mockImplementation(async (key: string) => {
    if (key === "selectionToolbar.enabled") return true
    if (key === "selectionToolbar.disabledApps") return ["1Password"]
    return null
  })
  startMock.mockRejectedValueOnce({ code: 500 })
  render(<SelectionToolbarSettings />)
  await screen.findByDisplayValue("1Password")
  fireEvent.click(screen.getByRole("button", { name: "saveDisabledApps" }))

  await waitFor(() =>
    expect(toastErrorMock).toHaveBeenCalledWith("enableFailed", {
      description: "[object Object]",
    })
  )
})

it("ignores a stored translation target that is no longer offered", async () => {
  getPrefMock.mockImplementation(async (key: string) => {
    if (key === "selectionToolbar.translateLocale") return "eo"
    if (key === "selectionToolbar.disabledApps") return ["1Password"]
    return false
  })
  render(<SelectionToolbarSettings />)
  await screen.findByDisplayValue("1Password")
  expect(screen.getByRole("combobox")).toHaveTextContent("languages.en")
})

it("survives unmounting before the stored prefs resolve", async () => {
  const releases: Array<(value: unknown) => void> = []
  getPrefMock.mockImplementation(
    () =>
      new Promise((resolve) => {
        releases.push(resolve)
      })
  )
  const { unmount } = render(<SelectionToolbarSettings />)
  await waitFor(() => expect(releases).toHaveLength(3))
  unmount()
  await act(async () => {
    releases.forEach((resolve) => resolve(null))
  })
  // No "state update on an unmounted component" warning, no throw.
})

it("copes with a never-saved app list", async () => {
  getPrefMock.mockResolvedValue(null)
  render(<SelectionToolbarSettings />)
  await waitFor(() => expect(screen.getByRole("switch", { name: "toggle" })).toBeEnabled())
  expect(screen.getByLabelText("disabledApps")).toHaveValue("")
})

it("reports a non-Error rejection without printing [object Object]", async () => {
  startMock.mockRejectedValueOnce("accessibility permission denied")
  render(<SelectionToolbarSettings />)
  await screen.findByDisplayValue("1Password")

  fireEvent.click(screen.getByRole("switch", { name: "toggle" }))

  await waitFor(() =>
    expect(toastErrorMock).toHaveBeenCalledWith("enableFailed", {
      description: "accessibility permission denied",
    })
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
