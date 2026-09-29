import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import en from "@/i18n/messages/en.json"

jest.mock("@tauri-apps/plugin-dialog", () => ({ open: jest.fn(), save: jest.fn() }))
jest.mock("@/lib/browser/passwords", () => ({
  ...jest.requireActual("@/lib/browser/passwords"),
  listPasswordSources: jest.fn(),
  importPasswordsFromBrowser: jest.fn(),
  importPasswordsFromCsv: jest.fn(),
}))

import { open as openDialog } from "@tauri-apps/plugin-dialog"
import {
  importPasswordsFromBrowser,
  importPasswordsFromCsv,
  listPasswordSources,
  type PasswordSource,
} from "@/lib/browser/passwords"

import { BrowserPasswordImportDialog } from "./browser-password-import-dialog"

const copy = en.browserVault.passwords.import

const SOURCES: PasswordSource[] = [
  {
    browser: "arc",
    label: "Arc",
    kind: "chromium",
    profiles: [],
    supported: false,
    reason: "not_installed",
  },
  {
    browser: "chrome",
    label: "Google Chrome",
    kind: "chromium",
    profiles: [
      { id: "Default", name: "Person 1" },
      { id: "Profile 1", name: "Work" },
    ],
    supported: true,
    reason: null,
  },
  {
    browser: "firefox",
    label: "Firefox",
    kind: "firefox",
    profiles: [{ id: "abc.default", name: "default-release" }],
    supported: true,
    reason: null,
  },
]

function renderDialog() {
  const onImported = jest.fn()
  render(<BrowserPasswordImportDialog open onOpenChange={jest.fn()} onImported={onImported} />)
  return { onImported }
}

beforeEach(() => {
  jest.clearAllMocks()
  ;(listPasswordSources as jest.Mock).mockResolvedValue(SOURCES)
})

it("picks the first usable browser, labels unavailable ones, and imports", async () => {
  const user = userEvent.setup()
  ;(importPasswordsFromBrowser as jest.Mock).mockResolvedValue({
    imported: 5,
    updated: 1,
    skipped: 2,
    skippedAppBound: 2,
    errors: [],
  })
  const { onImported } = renderDialog()
  const source = await screen.findByRole("combobox", { name: copy.source })
  expect(source).toHaveValue("chrome")
  expect(screen.getByRole("option", { name: "Arc (Not installed)" })).toBeDisabled()
  const profile = screen.getByRole("combobox", { name: copy.profile })
  expect(profile).toHaveValue("Default")
  await user.selectOptions(profile, "Profile 1")
  await user.click(screen.getByRole("button", { name: copy.run }))
  await waitFor(() =>
    expect(importPasswordsFromBrowser).toHaveBeenCalledWith("chrome", "Profile 1")
  )
  const result = await screen.findByTestId("password-import-result")
  expect(result).toHaveTextContent("Imported 5, updated 1, skipped 2.")
  expect(result).toHaveTextContent(/App-Bound Encryption/)
  expect(onImported).toHaveBeenCalled()
})

it("explains a Firefox primary password and counts other row errors", async () => {
  const user = userEvent.setup()
  ;(importPasswordsFromBrowser as jest.Mock).mockResolvedValue({
    imported: 0,
    updated: 0,
    skipped: 0,
    skippedAppBound: 0,
    errors: ["primary_password_set", "row 3: bad url"],
  })
  renderDialog()
  await user.selectOptions(await screen.findByRole("combobox", { name: copy.source }), "firefox")
  expect(screen.getByRole("combobox", { name: copy.profile })).toHaveValue("abc.default")
  await user.click(screen.getByRole("button", { name: copy.run }))
  const result = await screen.findByTestId("password-import-result")
  expect(result).toHaveTextContent(copy.primaryPasswordSet)
  expect(result).toHaveTextContent(/^.*1 row/)
  expect(importPasswordsFromBrowser).toHaveBeenCalledWith("firefox", "abc.default")
})

it("says when no browser has passwords", async () => {
  ;(listPasswordSources as jest.Mock).mockResolvedValue([SOURCES[0]])
  renderDialog()
  expect(await screen.findByText(copy.noSources)).toBeInTheDocument()
})

it("reports a failed source listing and a failed import", async () => {
  const user = userEvent.setup()
  ;(listPasswordSources as jest.Mock).mockRejectedValueOnce(new Error("x"))
  const { unmount } = render(
    <BrowserPasswordImportDialog open onOpenChange={jest.fn()} onImported={jest.fn()} />
  )
  expect(await screen.findByText(en.browserVault.common.failed)).toBeInTheDocument()
  unmount()

  ;(importPasswordsFromBrowser as jest.Mock).mockRejectedValue(new Error("keychain"))
  const { onImported } = renderDialog()
  await user.click(await screen.findByRole("button", { name: copy.run }))
  expect(await screen.findByRole("alert")).toHaveTextContent(copy.failed)
  expect(onImported).not.toHaveBeenCalled()
})

it("imports a CSV file with the chosen format, or auto-detects", async () => {
  const user = userEvent.setup()
  ;(openDialog as jest.Mock)
    .mockResolvedValueOnce("/tmp/bw.csv")
    .mockResolvedValueOnce("/tmp/any.csv")
  ;(importPasswordsFromCsv as jest.Mock).mockResolvedValue({
    imported: 3,
    updated: 0,
    skipped: 0,
    skippedAppBound: 0,
    errors: [],
  })
  const { onImported } = renderDialog()
  await user.click(screen.getByRole("tab", { name: copy.csvTab }))
  const format = await screen.findByRole("combobox", { name: copy.format })
  expect(within(format).getAllByRole("option")).toHaveLength(8)
  await user.selectOptions(format, "bitwarden")
  await user.click(screen.getByRole("button", { name: copy.chooseFile }))
  await waitFor(() =>
    expect(importPasswordsFromCsv).toHaveBeenCalledWith("/tmp/bw.csv", "bitwarden")
  )
  expect(openDialog).toHaveBeenCalledWith(
    expect.objectContaining({
      directory: false,
      filters: [expect.objectContaining({ extensions: ["csv"] })],
    })
  )
  expect(await screen.findByTestId("password-import-result")).toHaveTextContent("Imported 3")
  expect(onImported).toHaveBeenCalledTimes(1)

  await user.selectOptions(format, "auto")
  await user.click(screen.getByRole("button", { name: copy.chooseFile }))
  await waitFor(() =>
    expect(importPasswordsFromCsv).toHaveBeenLastCalledWith("/tmp/any.csv", undefined)
  )
})

it("does nothing when the CSV picker is cancelled", async () => {
  const user = userEvent.setup()
  ;(openDialog as jest.Mock).mockResolvedValue(null)
  renderDialog()
  await user.click(screen.getByRole("tab", { name: copy.csvTab }))
  await user.click(await screen.findByRole("button", { name: copy.chooseFile }))
  await waitFor(() => expect(openDialog).toHaveBeenCalled())
  expect(importPasswordsFromCsv).not.toHaveBeenCalled()
  expect(screen.queryByRole("alert")).toBeNull()
})
