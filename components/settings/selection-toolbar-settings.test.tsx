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
const statusMock = jest.fn()
const repairMock = jest.fn()
jest.mock("@/lib/tauri/selection-toolbar", () => ({
  SELECTION_TOOLBAR_ENABLED_PREF: "selectionToolbar.enabled",
  SELECTION_TOOLBAR_MODE_PREF: "selectionToolbar.mode",
  SELECTION_TOOLBAR_DISABLED_APPS_PREF: "selectionToolbar.disabledApps",
  SELECTION_TOOLBAR_DISABLED_SITES_PREF: "selectionToolbar.disabledSites",
  startSelectionToolbar: (...args: unknown[]) => startMock(...args),
  stopSelectionToolbar: () => stopMock(),
  getSelectionToolbarStatus: () => statusMock(),
  repairSelectionToolbarPermission: (...args: unknown[]) => repairMock(...args),
}))

const toastErrorMock = jest.fn()
jest.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => toastErrorMock(...args) },
}))

beforeEach(() => {
  jest.clearAllMocks()
  getPrefMock.mockImplementation(async (key: string) => {
    if (key === "selectionToolbar.enabled") return false
    if (key === "selectionToolbar.mode") return null
    if (key === "selectionToolbar.disabledApps") return ["1Password"]
    if (key === "selectionToolbar.disabledSites") return []
    if (key === "selectionToolbar.translateLocale") return "ja"
    if (key === "selectionToolbar.contextualActions") return true
    if (key === "selectionToolbar.searchEngine") return "google"
    return null
  })
  const status = {
    running: false,
    hasCandidate: false,
    mode: "off",
    accessibility: "ok",
    inputMonitoring: "ok",
    screenRecording: "missing",
    uia: "notApplicable",
    ocrAvailable: true,
    shortcutActivationActive: false,
    replaceAvailable: false,
  }
  statusMock.mockResolvedValue(status)
  startMock.mockResolvedValue({ ...status, running: true, mode: "automatic" })
  stopMock.mockResolvedValue(status)
  repairMock.mockResolvedValue(undefined)
})

it("loads the disabled app list and starts only after explicit opt-in", async () => {
  render(<SelectionToolbarSettings />)
  expect(await screen.findByDisplayValue("1Password")).toBeInTheDocument()

  fireEvent.click(screen.getByRole("switch", { name: "toggle" }))

  await waitFor(() =>
    expect(startMock).toHaveBeenCalledWith({
      mode: "automatic",
      disabledApps: ["1Password"],
      disabledSites: [],
    })
  )
  expect(setPrefMock).toHaveBeenCalledWith("selectionToolbar.mode", "automatic")
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
  expect(screen.getByRole("combobox", { name: "translateLanguage" })).toHaveTextContent(
    "languages.ja"
  )
})

it("persists a new translation target", async () => {
  render(<SelectionToolbarSettings />)
  await screen.findByDisplayValue("1Password")

  // Radix Select needs a keyboard-driven open in jsdom (no pointer geometry).
  const trigger = screen.getByRole("combobox", { name: "translateLanguage" })
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

it("keeps the toolbar marked on when stopping it fails", async () => {
  // A failed stop leaves the native monitor and the global chords live.
  // Persisting "off" would claim capture is disabled while it keeps running,
  // and the next launch would not even try to stop it.
  getPrefMock.mockImplementation(async (key: string) => {
    if (key === "selectionToolbar.enabled") return true
    if (key === "selectionToolbar.mode") return "automatic"
    if (key === "selectionToolbar.disabledApps") return ["1Password"]
    return null
  })
  stopMock.mockRejectedValueOnce(new Error("stop refused"))
  render(<SelectionToolbarSettings />)
  await screen.findByDisplayValue("1Password")

  fireEvent.click(screen.getByRole("switch", { name: "toggle" }))

  await waitFor(() =>
    expect(toastErrorMock).toHaveBeenCalledWith("disableFailed", {
      description: "stop refused",
    })
  )
  expect(setPrefMock).toHaveBeenCalledWith("selectionToolbar.enabled", true)
  expect(setPrefMock).toHaveBeenCalledWith("selectionToolbar.mode", "automatic")
  expect(setPrefMock).not.toHaveBeenCalledWith("selectionToolbar.enabled", false)
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

  await waitFor(() =>
    expect(startMock).toHaveBeenCalledWith({
      mode: "automatic",
      disabledApps: ["1Password", "KeePass"],
      disabledSites: [],
    })
  )
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
  expect(screen.getByRole("combobox", { name: "translateLanguage" })).toHaveTextContent(
    "languages.en"
  )
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
  await waitFor(() => expect(releases).toHaveLength(9))
  unmount()
  await act(async () => {
    releases.forEach((resolve) => resolve(null))
  })
  // No "state update on an unmounted component" warning, no throw.
})

it("supports manual activation and persists it independently of the legacy bit", async () => {
  render(<SelectionToolbarSettings />)
  await screen.findByDisplayValue("1Password")

  const trigger = screen.getByRole("combobox", { name: "mode" })
  fireEvent.keyDown(trigger, { key: "Enter" })
  fireEvent.click(await screen.findByRole("option", { name: "modes.manual" }))

  await waitFor(() =>
    expect(startMock).toHaveBeenCalledWith({
      mode: "manual",
      disabledApps: ["1Password"],
      disabledSites: [],
    })
  )
  expect(setPrefMock).toHaveBeenCalledWith("selectionToolbar.mode", "manual")
})

it("normalizes hostname exclusions without persisting paths or queries", async () => {
  render(<SelectionToolbarSettings />)
  await screen.findByDisplayValue("1Password")
  fireEvent.change(screen.getByLabelText("disabledSites"), {
    target: { value: "Example.com\nhttps://docs.example.com/private?token=secret" },
  })
  fireEvent.click(screen.getByRole("button", { name: "saveDisabledSites" }))

  await waitFor(() =>
    expect(setPrefMock).toHaveBeenCalledWith("selectionToolbar.disabledSites", [
      "example.com",
      "docs.example.com",
    ])
  )
})

it("renders live permission probes and opens repair only after a click", async () => {
  render(<SelectionToolbarSettings />)
  await screen.findByText("permissions.screenRecording")
  expect(screen.getByText("probes.missing")).toBeInTheDocument()
  expect(screen.getByText("shortcutInactive")).toBeInTheDocument()
  expect(repairMock).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole("button", { name: "openSettings" }))
  expect(repairMock).toHaveBeenCalledWith("screenRecording")
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
