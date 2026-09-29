import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import en from "@/i18n/messages/en.json"

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
jest.mock("@/lib/browser/passwords", () => ({
  ...jest.requireActual("@/lib/browser/passwords"),
  saveCredential: jest.fn(),
  updateCredential: jest.fn(),
}))

import { toast } from "sonner"
import { saveCredential, updateCredential, type CredentialMeta } from "@/lib/browser/passwords"

import {
  BrowserCredentialFormDialog,
  normalizeCredentialOrigin,
} from "./browser-credential-form-dialog"

const form = en.browserVault.passwords.form

const existing: CredentialMeta = {
  id: "c1",
  origin: "https://github.com",
  realm: null,
  username: "octocat",
  source: "manual",
  createdAt: 1,
  updatedAt: 1,
  lastUsedAt: null,
  note: "main",
}

beforeEach(() => jest.clearAllMocks())

describe("normalizeCredentialOrigin", () => {
  it.each([
    ["https://github.com/login?next=/", "https://github.com"],
    ["github.com", "https://github.com"],
    ["http://localhost:3000/a", "http://localhost:3000"],
    ["  https://EXAMPLE.com  ", "https://example.com"],
  ])("normalizes %p", (input, expected) => {
    expect(normalizeCredentialOrigin(input)).toBe(expected)
  })

  it.each(["", "   ", "ftp://files.example.com", "file:///etc/passwd", "https://"])(
    "rejects %p",
    (input) => {
      expect(normalizeCredentialOrigin(input)).toBeNull()
    }
  )
})

function renderDialog(credential: CredentialMeta | null = null) {
  const onOpenChange = jest.fn()
  const onSaved = jest.fn()
  render(
    <BrowserCredentialFormDialog
      open
      onOpenChange={onOpenChange}
      credential={credential}
      onSaved={onSaved}
    />
  )
  return { onOpenChange, onSaved, dialog: screen.getByRole("dialog") }
}

it("validates every field before saving", async () => {
  const user = userEvent.setup()
  const { dialog } = renderDialog()
  expect(within(dialog).getByText(form.addTitle, { selector: "h2" })).toBeInTheDocument()
  await user.type(within(dialog).getByLabelText(form.origin), "ftp://x")
  await user.click(within(dialog).getByRole("button", { name: form.save }))
  expect(within(dialog).getByText(form.invalidOrigin)).toBeInTheDocument()
  expect(within(dialog).getByText(form.usernameRequired)).toBeInTheDocument()
  expect(within(dialog).getByText(form.passwordRequired)).toBeInTheDocument()
  expect(within(dialog).getByLabelText(form.origin)).toHaveAttribute("aria-invalid", "true")
  expect(saveCredential).not.toHaveBeenCalled()
})

it("saves a new credential, with its note, and closes", async () => {
  const user = userEvent.setup()
  const saved = { ...existing, id: "new" }
  ;(saveCredential as jest.Mock).mockResolvedValue(saved)
  const { dialog, onSaved, onOpenChange } = renderDialog()
  await user.type(within(dialog).getByLabelText(form.origin), "https://github.com/login")
  await user.type(within(dialog).getByLabelText(form.username), " octocat ")
  await user.type(within(dialog).getByLabelText(form.password), "pw")
  await user.type(within(dialog).getByLabelText(form.note), "main")
  await user.click(within(dialog).getByRole("button", { name: form.save }))
  await waitFor(() =>
    expect(saveCredential).toHaveBeenCalledWith({
      origin: "https://github.com",
      username: "octocat",
      password: "pw",
      note: "main",
    })
  )
  expect(onSaved).toHaveBeenCalledWith(saved)
  expect(onOpenChange).toHaveBeenCalledWith(false)
  expect(toast.success).toHaveBeenCalledWith(form.saved)
})

it("toggles password visibility", async () => {
  const user = userEvent.setup()
  const { dialog } = renderDialog()
  const field = within(dialog).getByLabelText(form.password)
  expect(field).toHaveAttribute("type", "password")
  await user.click(within(dialog).getByRole("button", { name: en.browserVault.passwords.reveal }))
  expect(field).toHaveAttribute("type", "text")
})

it("edits with the origin fixed and sends a new password only when typed", async () => {
  const user = userEvent.setup()
  ;(updateCredential as jest.Mock).mockResolvedValue(existing)
  const { dialog } = renderDialog(existing)
  expect(within(dialog).getByLabelText(form.origin)).toHaveValue("https://github.com")
  expect(within(dialog).getByLabelText(form.origin)).toBeDisabled()
  expect(within(dialog).getByText(form.editPasswordHint)).toBeInTheDocument()
  await user.type(within(dialog).getByLabelText(form.password), "rotated")
  await user.click(within(dialog).getByRole("button", { name: form.save }))
  await waitFor(() =>
    expect(updateCredential).toHaveBeenCalledWith({
      id: "c1",
      username: "octocat",
      password: "rotated",
      note: "main",
    })
  )
  expect(toast.success).toHaveBeenCalledWith(form.updated)
})

it("keeps the dialog open and reports a failed save", async () => {
  const user = userEvent.setup()
  ;(updateCredential as jest.Mock).mockRejectedValue(new Error("store"))
  const { dialog, onOpenChange } = renderDialog(existing)
  await user.click(within(dialog).getByRole("button", { name: form.save }))
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith(en.browserVault.common.failed))
  expect(onOpenChange).not.toHaveBeenCalled()
})

it("cancels without saving", async () => {
  const user = userEvent.setup()
  const { dialog, onOpenChange } = renderDialog()
  await user.click(within(dialog).getByRole("button", { name: en.browserVault.common.cancel }))
  expect(onOpenChange).toHaveBeenCalledWith(false)
  expect(saveCredential).not.toHaveBeenCalled()
})
