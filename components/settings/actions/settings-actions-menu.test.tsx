/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const saveMock = jest.fn().mockResolvedValue(undefined)
const resetMock = jest.fn().mockResolvedValue(undefined)
const mockSettings = { id: "singleton", theme: "dark", language: "en", apiKey: "secret" }

jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T,>(
    selector: (s: {
      settings: typeof mockSettings
      save: typeof saveMock
      resetSettings: typeof resetMock
    }) => T
  ) => selector({ settings: mockSettings, save: saveMock, resetSettings: resetMock }),
}))

const downloadFileMock = jest.fn()
jest.mock("@/lib/files/download", () => ({
  downloadFile: (...args: unknown[]) => downloadFileMock(...args),
}))

const toastSuccess = jest.fn()
const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}))

import { SettingsActionsMenu } from "./settings-actions-menu"
import {
  exportSettingsProfile,
  serializeSettingsProfile,
  SETTINGS_PROFILE_SCHEMA,
} from "@/lib/settings/profile-transfer"

beforeEach(() => {
  saveMock.mockClear()
  resetMock.mockClear()
  downloadFileMock.mockClear()
  toastSuccess.mockClear()
  toastError.mockClear()
})

describe("SettingsActionsMenu", () => {
  it("renders the trigger", () => {
    render(<SettingsActionsMenu />)
    expect(screen.getByTestId("settings-actions-trigger")).toBeInTheDocument()
  })

  it("exports the settings profile and toasts", async () => {
    const user = userEvent.setup()
    render(<SettingsActionsMenu />)
    await user.click(screen.getByTestId("settings-actions-trigger"))
    await user.click(await screen.findByTestId("settings-export"))
    expect(downloadFileMock).toHaveBeenCalledTimes(1)
    const [filename, content, mime] = downloadFileMock.mock.calls[0]
    expect(filename).toMatch(/^cognia-settings-.*\.json$/)
    expect(mime).toBe("application/json")
    const parsed = JSON.parse(content as string)
    expect(parsed.schema).toBe(SETTINGS_PROFILE_SCHEMA)
    expect(parsed.settings.apiKey).toBeUndefined() // secret stripped
    expect(toastSuccess).toHaveBeenCalled()
  })

  // jsdom's File lacks a working .text(); supply one so the component's
  // standard `file.text()` resolves under test.
  function fakeFile(content: string, name = "p.json"): File {
    return { name, text: () => Promise.resolve(content) } as unknown as File
  }

  it("imports a valid profile and saves the patch", async () => {
    const profile = exportSettingsProfile(
      { ...mockSettings, theme: "light" } as never,
      "2026-06-15T00:00:00.000Z"
    )
    const file = fakeFile(serializeSettingsProfile(profile))
    render(<SettingsActionsMenu />)
    fireEvent.change(screen.getByTestId("settings-import-input"), { target: { files: [file] } })
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1))
    expect(saveMock.mock.calls[0][0].theme).toBe("light")
    expect(toastSuccess).toHaveBeenCalled()
  })

  it("toasts an error on an invalid import file", async () => {
    const file = fakeFile("{not json", "bad.json")
    render(<SettingsActionsMenu />)
    fireEvent.change(screen.getByTestId("settings-import-input"), { target: { files: [file] } })
    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(saveMock).not.toHaveBeenCalled()
  })

  it("opens the changed-settings review dialog from the menu", async () => {
    const user = userEvent.setup()
    render(<SettingsActionsMenu />)
    await user.click(screen.getByTestId("settings-actions-trigger"))
    await user.click(await screen.findByTestId("settings-review-changed"))
    expect(await screen.findByTestId("changed-settings-dialog")).toBeInTheDocument()
  })

  it("resets all settings after confirming", async () => {
    const user = userEvent.setup()
    render(<SettingsActionsMenu />)
    await user.click(screen.getByTestId("settings-actions-trigger"))
    await user.click(await screen.findByTestId("settings-reset"))
    await user.click(await screen.findByTestId("settings-reset-confirm"))
    await waitFor(() => expect(resetMock).toHaveBeenCalledTimes(1))
    expect(toastSuccess).toHaveBeenCalled()
  })
})
