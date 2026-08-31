/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { Account, AccountSummary } from "@/types/subscription"

// next-intl is globally mocked against en.json in jest.setup.ts.

const saveOpencodeZenKeyMock = jest.fn()
jest.mock("@/lib/subscription/opencode/discovery", () => ({
  saveOpencodeZenKey: (...a: unknown[]) => saveOpencodeZenKeyMock(...a),
}))

const persistProviderAccountMock = jest.fn()
const replaceAccountCredentialMock = jest.fn()
jest.mock("@/lib/subscription/core/account-lifecycle", () => ({
  persistProviderAccount: (...a: unknown[]) => persistProviderAccountMock(...a),
}))
jest.mock("@/lib/subscription/core/transport", () => ({
  replaceAccountCredential: (...a: unknown[]) => replaceAccountCredentialMock(...a),
}))

import { OpencodeAddAccountDialog } from "./opencode"

function account(): Account {
  return {
    id: "acc-1",
    credential: { provider: "opencode-zen", accessToken: "sk", storedAtMs: 0 },
    createdAtMs: 0,
    lastUsedAtMs: 0,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  persistProviderAccountMock.mockImplementation(async (_provider, next) => next)
  replaceAccountCredentialMock.mockResolvedValue(account())
})

describe("OpencodeAddAccountDialog", () => {
  it("defaults to the zen plan and submits it", async () => {
    saveOpencodeZenKeyMock.mockResolvedValueOnce(account())
    const onAdded = jest.fn()
    render(<OpencodeAddAccountDialog open onOpenChange={() => {}} onAdded={onAdded} />)

    await userEvent.type(screen.getByLabelText(/api key/i), "sk-zen-1")
    await userEvent.click(screen.getByRole("button", { name: /save/i }))

    expect(saveOpencodeZenKeyMock).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "sk-zen-1", plan: "zen" })
    )
    expect(onAdded).toHaveBeenCalled()
  })

  it("submits the go plan when selected", async () => {
    saveOpencodeZenKeyMock.mockResolvedValueOnce(account())
    render(<OpencodeAddAccountDialog open onOpenChange={() => {}} />)

    await userEvent.click(screen.getByRole("radio", { name: /go/i }))
    await userEvent.type(screen.getByLabelText(/api key/i), "sk-go-1")
    await userEvent.click(screen.getByRole("button", { name: /save/i }))

    expect(saveOpencodeZenKeyMock).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "sk-go-1", plan: "go" })
    )
  })

  it("switches the label placeholder to the Go default", async () => {
    render(<OpencodeAddAccountDialog open onOpenChange={() => {}} />)
    expect(screen.getByPlaceholderText("OpenCode Zen")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("radio", { name: /go/i }))
    expect(screen.getByPlaceholderText("OpenCode Go")).toBeInTheDocument()
  })

  it("surfaces a save error inline", async () => {
    saveOpencodeZenKeyMock.mockRejectedValueOnce(new Error("keyring locked"))
    const onOpenChange = jest.fn()
    render(<OpencodeAddAccountDialog open onOpenChange={onOpenChange} />)

    await userEvent.type(screen.getByLabelText(/api key/i), "sk-bad")
    await userEvent.click(screen.getByRole("button", { name: /save/i }))

    expect(await screen.findByText(/keyring locked/)).toBeInTheDocument()
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })

  it("disables save while the key field is empty", () => {
    render(<OpencodeAddAccountDialog open onOpenChange={() => {}} />)
    expect(screen.getByRole("button", { name: /save/i })).toBeDisabled()
  })

  it("updates credentials in place while preserving metadata", async () => {
    const onUpdated = jest.fn()
    const existing: AccountSummary = {
      id: "existing-id",
      provider: "opencode",
      variant: "opencode-zen",
      label: "Work",
      plan: "go",
      createdAtMs: 123,
      lastUsedAtMs: 456,
      expiresAtMs: 0,
      authMode: "api_key",
      credentialSource: "managed",
      health: "ready",
      isExternal: false,
    }
    render(
      <OpencodeAddAccountDialog
        open
        onOpenChange={() => {}}
        existingAccount={existing}
        onUpdated={onUpdated}
      />
    )

    await userEvent.type(screen.getByLabelText(/api key/i), "sk-replacement")
    await userEvent.click(screen.getByRole("button", { name: /save/i }))

    expect(replaceAccountCredentialMock).toHaveBeenCalledWith(
      "opencode",
      "existing-id",
      expect.objectContaining({
        provider: "opencode-zen",
        accessToken: "sk-replacement",
        plan: "go",
      })
    )
    expect(saveOpencodeZenKeyMock).not.toHaveBeenCalled()
    expect(persistProviderAccountMock).not.toHaveBeenCalled()
    expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({ id: "acc-1" }))
  })
})
