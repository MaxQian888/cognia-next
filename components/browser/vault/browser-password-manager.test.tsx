import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import en from "@/i18n/messages/en.json"

jest.mock("@tauri-apps/plugin-dialog", () => ({ open: jest.fn(), save: jest.fn() }))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() } }))
jest.mock("@/lib/browser/passwords", () => ({
  ...jest.requireActual("@/lib/browser/passwords"),
  listCredentials: jest.fn(),
  revealCredential: jest.fn(),
  copyCredential: jest.fn(),
  deleteCredential: jest.fn(),
  exportCredentials: jest.fn(),
  saveCredential: jest.fn(),
  updateCredential: jest.fn(),
  listPasswordSources: jest.fn(),
  importPasswordsFromBrowser: jest.fn(),
  importPasswordsFromCsv: jest.fn(),
}))

import { save as saveDialog } from "@tauri-apps/plugin-dialog"
import { toast } from "sonner"
import {
  copyCredential,
  deleteCredential,
  exportCredentials,
  listCredentials,
  listPasswordSources,
  revealCredential,
  saveCredential,
  updateCredential,
  type CredentialMeta,
} from "@/lib/browser/passwords"

import { BrowserPasswordManager } from "./browser-password-manager"

const copy = en.browserVault.passwords
const presence = en.browserVault.presence

function credential(overrides: Partial<CredentialMeta> = {}): CredentialMeta {
  return {
    id: "c1",
    origin: "https://github.com",
    realm: null,
    username: "octocat",
    source: "manual",
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: Date.UTC(2026, 0, 2),
    note: null,
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.useRealTimers()
  ;(listCredentials as jest.Mock).mockResolvedValue([
    credential({ id: "c2", origin: "https://example.com", username: "alice", note: "work" }),
    credential(),
  ])
  ;(listPasswordSources as jest.Mock).mockResolvedValue([])
})

function rowFor(origin: string) {
  return screen.getByRole("group", { name: `Actions for ${origin}` }).closest("li") as HTMLElement
}

it("lists credentials sorted by site with metadata and never a password", async () => {
  render(<BrowserPasswordManager />)
  const items = await screen.findAllByRole("listitem")
  expect(items[0]).toHaveTextContent("https://example.com")
  expect(items[1]).toHaveTextContent("https://github.com")
  expect(within(items[1]).getByText(copy.source.manual)).toBeInTheDocument()
  expect(within(items[0]).getByText("work")).toBeInTheDocument()
  expect(screen.getByTestId("credential-secret-c1")).toHaveTextContent("••••••••")
  expect(screen.getByText(/^2 saved password/)).toBeInTheDocument()
})

it("filters by site, username or note and explains an empty search", async () => {
  const user = userEvent.setup()
  render(<BrowserPasswordManager />)
  await screen.findAllByRole("listitem")
  const search = screen.getByRole("searchbox", { name: copy.search })
  await user.type(search, "ALICE")
  expect(screen.getAllByRole("listitem")).toHaveLength(1)
  await user.clear(search)
  await user.type(search, "nothing")
  expect(screen.getByText("No saved password matches “nothing”.")).toBeInTheDocument()
})

it("shows the empty state", async () => {
  ;(listCredentials as jest.Mock).mockResolvedValue([])
  render(<BrowserPasswordManager />)
  expect(await screen.findByText(copy.empty)).toBeInTheDocument()
  expect(screen.getByRole("button", { name: copy.export.action })).toBeDisabled()
})

it("offers a retry when loading fails", async () => {
  const user = userEvent.setup()
  ;(listCredentials as jest.Mock).mockRejectedValueOnce(new Error("store locked"))
  render(<BrowserPasswordManager />)
  expect(await screen.findByText(copy.loadFailed)).toBeInTheDocument()
  await user.click(screen.getByRole("button", { name: en.browserVault.common.retry }))
  expect(await screen.findAllByRole("listitem")).toHaveLength(2)
})

it("reveals after presence, hides on demand", async () => {
  const user = userEvent.setup()
  ;(revealCredential as jest.Mock).mockResolvedValue({ password: "hunter2" })
  render(<BrowserPasswordManager />)
  await screen.findAllByRole("listitem")
  await user.click(within(rowFor("https://github.com")).getByRole("button", { name: copy.reveal }))
  expect(revealCredential).toHaveBeenCalledWith("c1")
  expect(await screen.findByText("hunter2")).toBeInTheDocument()
  await user.click(within(rowFor("https://github.com")).getByRole("button", { name: copy.hide }))
  expect(screen.queryByText("hunter2")).toBeNull()
})

it("hides a revealed password again after 30 seconds", async () => {
  jest.useFakeTimers()
  const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime })
  ;(revealCredential as jest.Mock).mockResolvedValue({ password: "hunter2" })
  render(<BrowserPasswordManager />)
  await screen.findAllByRole("listitem")
  await user.click(within(rowFor("https://github.com")).getByRole("button", { name: copy.reveal }))
  expect(await screen.findByText("hunter2")).toBeInTheDocument()
  act(() => {
    jest.advanceTimersByTime(30_000)
  })
  expect(screen.queryByText("hunter2")).toBeNull()
})

it.each([
  ["user_presence_denied", presence.denied],
  ["user_presence_unavailable", presence.unavailable],
  ["user_presence_cancelled", presence.cancelled],
  ["disk full", en.browserVault.common.failed],
])("explains a refused reveal (%s)", async (code, message) => {
  const user = userEvent.setup()
  ;(revealCredential as jest.Mock).mockRejectedValue(new Error(code))
  render(<BrowserPasswordManager />)
  await screen.findAllByRole("listitem")
  await user.click(within(rowFor("https://github.com")).getByRole("button", { name: copy.reveal }))
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith(message))
  expect(screen.getByTestId("credential-secret-c1")).toHaveTextContent("••••••••")
})

it("copies through Rust and reports presence failures", async () => {
  const user = userEvent.setup()
  ;(copyCredential as jest.Mock)
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("user_presence_unavailable"))
  render(<BrowserPasswordManager />)
  await screen.findAllByRole("listitem")
  const button = within(rowFor("https://github.com")).getByRole("button", { name: copy.copy })
  await user.click(button)
  await waitFor(() => expect(toast.success).toHaveBeenCalledWith(copy.copied))
  await user.click(button)
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith(presence.unavailable))
})

it("deletes after confirmation", async () => {
  const user = userEvent.setup()
  ;(deleteCredential as jest.Mock).mockResolvedValue(undefined)
  render(<BrowserPasswordManager />)
  await screen.findAllByRole("listitem")
  await user.click(within(rowFor("https://github.com")).getByRole("button", { name: copy.delete }))
  const dialog = await screen.findByRole("alertdialog")
  expect(dialog).toHaveTextContent("octocat")
  await user.click(within(dialog).getByRole("button", { name: copy.deleteConfirm.confirm }))
  await waitFor(() => expect(deleteCredential).toHaveBeenCalledWith("c1"))
  await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(1))
  expect(toast.success).toHaveBeenCalledWith(copy.deleted)
})

it("warns, then asks Rust to export (Rust picks the path)", async () => {
  const user = userEvent.setup()
  ;(exportCredentials as jest.Mock).mockResolvedValue({ exported: 2 })
  render(<BrowserPasswordManager />)
  await screen.findAllByRole("listitem")
  await user.click(screen.getByRole("button", { name: copy.export.action }))
  const dialog = await screen.findByRole("alertdialog")
  expect(dialog).toHaveTextContent(copy.export.warning)
  await user.click(within(dialog).getByRole("button", { name: copy.export.confirm }))
  await waitFor(() => expect(exportCredentials).toHaveBeenCalledWith())
  expect(saveDialog).not.toHaveBeenCalled()
  expect(toast.success).toHaveBeenCalledWith(copy.export.done)
})

it("stays quiet when the save dialog is cancelled, and explains a presence refusal", async () => {
  const user = userEvent.setup()
  ;(exportCredentials as jest.Mock)
    .mockResolvedValueOnce(null)
    .mockRejectedValueOnce(new Error("user_presence_denied"))
  render(<BrowserPasswordManager />)
  await screen.findAllByRole("listitem")
  await user.click(screen.getByRole("button", { name: copy.export.action }))
  await user.click(await screen.findByRole("button", { name: copy.export.confirm }))
  await waitFor(() => expect(exportCredentials).toHaveBeenCalledTimes(1))
  expect(toast.success).not.toHaveBeenCalledWith(copy.export.done)
  expect(toast.error).not.toHaveBeenCalled()
  await user.click(screen.getByRole("button", { name: copy.export.action }))
  await user.click(await screen.findByRole("button", { name: copy.export.confirm }))
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith(presence.denied))
})

it("adds a credential with a normalized origin", async () => {
  const user = userEvent.setup()
  ;(saveCredential as jest.Mock).mockResolvedValue(
    credential({ id: "c3", origin: "https://news.ycombinator.com", username: "pg" })
  )
  render(<BrowserPasswordManager />)
  await screen.findAllByRole("listitem")
  await user.click(screen.getByRole("button", { name: copy.add }))
  const dialog = await screen.findByRole("dialog")
  await user.type(within(dialog).getByLabelText(copy.form.origin), "news.ycombinator.com/login")
  await user.type(within(dialog).getByLabelText(copy.form.username), "pg")
  await user.type(within(dialog).getByLabelText(copy.form.password), "s3cret")
  await user.click(within(dialog).getByRole("button", { name: copy.form.save }))
  await waitFor(() =>
    expect(saveCredential).toHaveBeenCalledWith({
      origin: "https://news.ycombinator.com",
      username: "pg",
      password: "s3cret",
    })
  )
  expect(await screen.findByText("https://news.ycombinator.com")).toBeInTheDocument()
  expect(screen.queryByRole("dialog")).toBeNull()
})

it("edits a credential without resending the password when left empty", async () => {
  const user = userEvent.setup()
  ;(updateCredential as jest.Mock).mockResolvedValue(credential({ username: "octo" }))
  render(<BrowserPasswordManager />)
  await screen.findAllByRole("listitem")
  await user.click(within(rowFor("https://github.com")).getByRole("button", { name: copy.edit }))
  const dialog = await screen.findByRole("dialog")
  expect(within(dialog).getByLabelText(copy.form.origin)).toBeDisabled()
  const username = within(dialog).getByLabelText(copy.form.username)
  await user.clear(username)
  await user.type(username, "octo")
  await user.click(within(dialog).getByRole("button", { name: copy.form.save }))
  await waitFor(() =>
    expect(updateCredential).toHaveBeenCalledWith({ id: "c1", username: "octo", note: "" })
  )
  expect(await screen.findByText("octo")).toBeInTheDocument()
})

it("opens the import dialog", async () => {
  const user = userEvent.setup()
  render(<BrowserPasswordManager />)
  await screen.findAllByRole("listitem")
  await user.click(screen.getByRole("button", { name: copy.import.action }))
  expect(await screen.findByRole("dialog", { name: copy.import.title })).toBeInTheDocument()
})
