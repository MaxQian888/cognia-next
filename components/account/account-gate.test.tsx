/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { LocalAccountRecord, PasswordVerifierRecord } from "@/lib/accounts/account-types"
import type { AccountStoreState } from "@/stores/account/account-store"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, string>) =>
    values ? `${key}:${Object.values(values).join(",")}` : key,
}))

// AccountGate only gates on Tauri; off Tauri it passes through. Default the
// mock to Tauri so the local-account form/unlock tests below keep exercising
// the gate; the pass-through tests flip it to false.
let mockIsTauri = true
jest.mock("@/lib/tauri", () => ({
  isTauri: () => mockIsTauri,
}))

// The pet overlay / popup windows load the same layout; the gate must pass
// through there so the transparent sprite window never shows a lock form.
// Default to "main" so the ordinary gate tests are unaffected.
let mockPetRole: "main" | "web" | "overlay" | "popup" = "main"
jest.mock("@/lib/pet/window-role", () => ({
  getPetWindowRole: () => mockPetRole,
}))

const mockCreateAccount = jest.fn<Promise<LocalAccountRecord>, [unknown]>()
const mockUnlockAccount = jest.fn<Promise<void>, [string, string]>()

let mockState: Pick<
  AccountStoreState,
  | "accounts"
  | "activeAccountId"
  | "unlockedAccountId"
  | "loaded"
  | "loading"
  | "locked"
  | "error"
  | "createAccount"
  | "unlockAccount"
>

jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: (selector: (state: typeof mockState) => unknown) => selector(mockState),
  selectActiveAccount: (state: typeof mockState) =>
    state.accounts.find((account) => account.id === state.activeAccountId) ?? null,
}))

import { AccountGate } from "./account-gate"

const verifier: PasswordVerifierRecord = {
  algorithm: "argon2id-v1",
  salt: "salt",
  hash: "hash",
  params: {},
}

function account(id: string, displayName: string): LocalAccountRecord {
  return {
    id,
    displayName,
    passwordVerifier: verifier,
    createdAt: 1,
    updatedAt: 1,
  }
}

function setGateState(overrides: Partial<typeof mockState> = {}) {
  mockState = {
    accounts: [],
    activeAccountId: null,
    unlockedAccountId: null,
    loaded: true,
    loading: false,
    locked: false,
    error: null,
    createAccount: mockCreateAccount,
    unlockAccount: mockUnlockAccount,
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockIsTauri = true
  mockPetRole = "main"
  mockCreateAccount.mockResolvedValue(account("acct_first", "First"))
  mockUnlockAccount.mockResolvedValue()
  setGateState()
})

describe("AccountGate", () => {
  it("renders a loading state while the registry has not hydrated", () => {
    setGateState({ loaded: false, loading: true })
    render(
      <AccountGate>
        <div>child</div>
      </AccountGate>
    )
    expect(screen.getByText("loading")).toBeInTheDocument()
    expect(screen.queryByText("child")).not.toBeInTheDocument()
  })

  it("still shows the loading shell off Tauri before the registry hydrates", () => {
    mockIsTauri = false
    setGateState({ loaded: false, loading: true })
    render(
      <AccountGate>
        <div>child</div>
      </AccountGate>
    )
    // The Tauri bypass sits after the loaded gate, so server + first client
    // render agree on the loading shell (no hydration mismatch).
    expect(screen.getByText("loading")).toBeInTheDocument()
    expect(screen.queryByText("child")).not.toBeInTheDocument()
  })

  it("passes through to children off Tauri instead of the create-account form", () => {
    mockIsTauri = false
    setGateState({ accounts: [] })
    render(
      <AccountGate>
        <div>child</div>
      </AccountGate>
    )
    // Mobile/web: no local-account form (its IPC always throws). The /pair
    // gate downstream takes over instead.
    expect(screen.getByText("child")).toBeInTheDocument()
    expect(screen.queryByText("firstRunTitle")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "createAccount" })).not.toBeInTheDocument()
  })

  it("passes through to children off Tauri even when the registry reports locked", () => {
    mockIsTauri = false
    setGateState({
      accounts: [account("acct_alpha", "Alpha")],
      activeAccountId: "acct_alpha",
      locked: true,
    })
    render(
      <AccountGate>
        <div>child</div>
      </AccountGate>
    )
    expect(screen.getByText("child")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "unlockAccount" })).not.toBeInTheDocument()
  })

  it.each(["overlay", "popup"] as const)(
    "passes through to children in the %s pet window even when locked on Tauri",
    (role) => {
      mockPetRole = role
      setGateState({
        accounts: [account("acct_alpha", "Alpha")],
        activeAccountId: "acct_alpha",
        locked: true,
      })
      render(
        <AccountGate>
          <div>child</div>
        </AccountGate>
      )
      // The transparent pet window must paint its sprite, not an opaque lock
      // form — the gate is a main-window concern.
      expect(screen.getByText("child")).toBeInTheDocument()
      expect(screen.queryByRole("button", { name: "unlockAccount" })).not.toBeInTheDocument()
    }
  )

  it("still gates the main window on Tauri when locked", () => {
    mockPetRole = "main"
    setGateState({
      accounts: [account("acct_alpha", "Alpha")],
      activeAccountId: "acct_alpha",
      locked: true,
    })
    render(
      <AccountGate>
        <div>child</div>
      </AccountGate>
    )
    expect(screen.getByRole("button", { name: "unlockAccount" })).toBeInTheDocument()
    expect(screen.queryByText("child")).not.toBeInTheDocument()
  })

  it("creates the first account from the first-run form", async () => {
    render(
      <AccountGate>
        <div>child</div>
      </AccountGate>
    )

    fireEvent.change(screen.getByLabelText("displayNameLabel"), {
      target: { value: "Local User" },
    })
    fireEvent.change(screen.getByLabelText("passwordLabel"), {
      target: { value: "secret-pw" },
    })
    fireEvent.click(screen.getByRole("button", { name: "createAccount" }))

    await waitFor(() =>
      expect(mockCreateAccount).toHaveBeenCalledWith({
        displayName: "Local User",
        password: "secret-pw",
      })
    )
    expect(screen.queryByText("child")).not.toBeInTheDocument()
  })

  it("blocks the first-run create below the minimum password length", () => {
    render(
      <AccountGate>
        <div>child</div>
      </AccountGate>
    )

    fireEvent.change(screen.getByLabelText("displayNameLabel"), {
      target: { value: "Local User" },
    })
    fireEvent.change(screen.getByLabelText("passwordLabel"), {
      target: { value: "short" },
    })
    fireEvent.click(screen.getByRole("button", { name: "createAccount" }))

    expect(screen.getByText("passwordTooShort:8")).toBeInTheDocument()
    expect(mockCreateAccount).not.toHaveBeenCalled()
  })

  it("shows a string create error from the first-run form", async () => {
    mockCreateAccount.mockRejectedValueOnce("name already exists")

    render(
      <AccountGate>
        <div>child</div>
      </AccountGate>
    )

    fireEvent.change(screen.getByLabelText("displayNameLabel"), {
      target: { value: "Local User" },
    })
    fireEvent.change(screen.getByLabelText("passwordLabel"), {
      target: { value: "secret-pw" },
    })
    fireEvent.click(screen.getByRole("button", { name: "createAccount" }))

    expect(await screen.findByText("name already exists")).toBeInTheDocument()
  })

  it("falls back to the translated operation error for unknown create failures", async () => {
    mockCreateAccount.mockRejectedValueOnce({ code: "bad-input" })

    render(
      <AccountGate>
        <div>child</div>
      </AccountGate>
    )

    fireEvent.change(screen.getByLabelText("displayNameLabel"), {
      target: { value: "Local User" },
    })
    fireEvent.change(screen.getByLabelText("passwordLabel"), {
      target: { value: "secret-pw" },
    })
    fireEvent.click(screen.getByRole("button", { name: "createAccount" }))

    expect(await screen.findByText("operationFailed")).toBeInTheDocument()
  })

  it("prompts for the active account password when locked", async () => {
    const alpha = account("acct_alpha", "Alpha")
    setGateState({
      accounts: [alpha],
      activeAccountId: "acct_alpha",
      locked: true,
    })

    render(
      <AccountGate>
        <div>child</div>
      </AccountGate>
    )

    expect(screen.getByText("unlockTitle:Alpha")).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText("passwordLabel"), {
      target: { value: "secret" },
    })
    fireEvent.click(screen.getByRole("button", { name: "unlockAccount" }))

    await waitFor(() => expect(mockUnlockAccount).toHaveBeenCalledWith("acct_alpha", "secret"))
    expect(screen.queryByText("child")).not.toBeInTheDocument()
  })

  it("renders children once an account is unlocked", () => {
    const alpha = account("acct_alpha", "Alpha")
    setGateState({
      accounts: [alpha],
      activeAccountId: "acct_alpha",
      unlockedAccountId: "acct_alpha",
      locked: false,
    })

    render(
      <AccountGate>
        <div>child</div>
      </AccountGate>
    )

    expect(screen.getByText("child")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "unlockAccount" })).not.toBeInTheDocument()
  })

  it("shows store errors and action errors", async () => {
    const alpha = account("acct_alpha", "Alpha")
    mockUnlockAccount.mockRejectedValueOnce(new Error("bad password"))
    setGateState({
      accounts: [alpha],
      activeAccountId: "acct_alpha",
      locked: true,
      error: "previous error",
    })

    render(
      <AccountGate>
        <div>child</div>
      </AccountGate>
    )

    expect(screen.getByText("previous error")).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText("passwordLabel"), {
      target: { value: "bad" },
    })
    fireEvent.click(screen.getByRole("button", { name: "unlockAccount" }))

    await screen.findByText("bad password")
  })

  it("falls back to the first account and unknown-account copy when no active id resolves", () => {
    setGateState({
      accounts: [account("acct_alpha", "Alpha")],
      activeAccountId: "missing",
      locked: true,
    })

    render(
      <AccountGate>
        <div>child</div>
      </AccountGate>
    )

    expect(screen.getByText("unlockTitle:Alpha")).toBeInTheDocument()

    setGateState({ accounts: [], activeAccountId: null, locked: true })
    const { rerender } = render(
      <AccountGate>
        <div>child</div>
      </AccountGate>
    )
    rerender(
      <AccountGate>
        <div>child</div>
      </AccountGate>
    )
    expect(screen.getByText("firstRunTitle")).toBeInTheDocument()
  })
})
