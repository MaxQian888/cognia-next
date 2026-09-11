/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { AccountSummary } from "@/types/subscription"

const persist = jest.fn()
const replace = jest.fn()
const rename = jest.fn()
jest.mock("@/lib/subscription/core/account-lifecycle", () => ({
  persistProviderAccount: (...args: unknown[]) => persist(...args),
}))
jest.mock("@/lib/tauri", () => ({ isTauri: () => true }))
jest.mock("@/lib/subscription/core/transport", () => ({
  listPresets: jest.fn(async () => [
    { id: "relay", label: "Relay", baseUrl: "https://relay.example" },
  ]),
  replaceAccountCredential: (...args: unknown[]) => replace(...args),
  renameAccount: (...args: unknown[]) => rename(...args),
}))
import { CommandcodeAddAccountDialog } from "./commandcode"

const existing: AccountSummary = {
  id: "account-1",
  provider: "commandcode",
  variant: "commandcode",
  label: "Work",
  createdAtMs: 1,
  lastUsedAtMs: 2,
  expiresAtMs: 0,
  authMode: "api_key",
  credentialSource: "managed",
  health: "ready",
  isExternal: false,
}

beforeEach(() => {
  jest.clearAllMocks()
  persist.mockImplementation(async (_provider, account) => account)
  replace.mockResolvedValue({ ...existing, presetId: "bound-relay" })
  rename.mockResolvedValue(undefined)
})

it("creates a managed API account with the selected preset and exposes plan boundaries", async () => {
  const onAdded = jest.fn()
  render(<CommandcodeAddAccountDialog open onOpenChange={jest.fn()} onAdded={onAdded} />)
  fireEvent.change(await screen.findByRole("combobox"), { target: { value: "relay" } })
  expect(screen.getByText(/Go plan does not include/)).toBeInTheDocument()
  expect(screen.getByRole("link", { name: /Create an API key/ })).toHaveAttribute(
    "href",
    "https://commandcode.ai/settings/keys"
  )
  await userEvent.type(screen.getByLabelText("API key"), "cc-test-key")
  await userEvent.click(screen.getByRole("button", { name: "Save" }))
  await waitFor(() => expect(onAdded).toHaveBeenCalled())
  expect(persist).toHaveBeenCalledWith(
    "commandcode",
    expect.objectContaining({
      id: expect.any(String),
      presetId: "relay",
      credential: {
        provider: "commandcode",
        accessToken: "cc-test-key",
        baseUrl: undefined,
        storedAtMs: expect.any(Number),
      },
    })
  )
})

it("replaces credentials in place and preserves the returned preset binding", async () => {
  const onUpdated = jest.fn()
  render(
    <CommandcodeAddAccountDialog
      open
      onOpenChange={jest.fn()}
      existingAccount={existing}
      onUpdated={onUpdated}
    />
  )
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument()
  await userEvent.type(screen.getByLabelText("API key"), "replacement")
  fireEvent.change(screen.getByLabelText("Label (optional)"), { target: { value: "New label" } })
  await userEvent.click(screen.getByRole("button", { name: "Save" }))
  await waitFor(() =>
    expect(onUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ id: "account-1", label: "New label", presetId: "bound-relay" })
    )
  )
  expect(replace).toHaveBeenCalledWith(
    "commandcode",
    "account-1",
    expect.objectContaining({ accessToken: "replacement" })
  )
  expect(rename).toHaveBeenCalledWith("commandcode", "account-1", "New label")
  expect(persist).not.toHaveBeenCalled()
})

it.each([
  ["invalid key", "", /cannot contain whitespace/],
  ["valid", "ftp://example.com", /valid HTTP/],
  ["valid", "https://user:password@example.com", /valid HTTP/],
])("rejects invalid credentials or endpoint %s %s", async (key, endpoint, error) => {
  render(<CommandcodeAddAccountDialog open onOpenChange={jest.fn()} />)
  await screen.findByRole("combobox")
  fireEvent.change(screen.getByLabelText("API key"), { target: { value: key } })
  fireEvent.change(screen.getByLabelText("Base URL (optional)"), { target: { value: endpoint } })
  await userEvent.click(screen.getByRole("button", { name: "Save" }))
  expect(screen.getByText(error)).toBeInTheDocument()
  expect(persist).not.toHaveBeenCalled()
})

it("keeps errors visible and clears secret drafts on reopen", async () => {
  persist.mockRejectedValueOnce(new Error("keyring locked"))
  const onOpenChange = jest.fn()
  const view = render(<CommandcodeAddAccountDialog open onOpenChange={onOpenChange} />)
  await userEvent.type(screen.getByLabelText("API key"), "test-key")
  await userEvent.click(screen.getByRole("button", { name: "Save" }))
  expect(await screen.findByText(/keyring locked/)).toBeInTheDocument()
  expect(onOpenChange).not.toHaveBeenCalledWith(false)
  view.rerender(<CommandcodeAddAccountDialog open={false} onOpenChange={onOpenChange} />)
  view.rerender(<CommandcodeAddAccountDialog open onOpenChange={onOpenChange} />)
  await screen.findByRole("combobox")
  expect(screen.getByLabelText("API key")).toHaveValue("")
  expect(screen.queryByText(/keyring locked/)).not.toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
})

it("does not dismiss or allow duplicate submission while persistence is pending", async () => {
  let finish!: (account: unknown) => void
  persist.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const onOpenChange = jest.fn()
  render(<CommandcodeAddAccountDialog open onOpenChange={onOpenChange} />)
  await userEvent.type(screen.getByLabelText("API key"), "pending-key")
  await userEvent.click(screen.getByRole("button", { name: "Save" }))
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
  expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled()
  await userEvent.keyboard("{Escape}")
  expect(onOpenChange).not.toHaveBeenCalled()
  finish({ id: "saved" })
  await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  expect(persist).toHaveBeenCalledTimes(1)
})
