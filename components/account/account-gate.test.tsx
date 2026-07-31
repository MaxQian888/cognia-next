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

jest.mock("@/hooks/use-network-status", () => ({
  useNetworkStatus: () => ({
    loading: false,
    status: { connected: true, connectionType: "wifi" as const },
  }),
}))

let mockIsTauri = true
let mockIsCapacitor = false
jest.mock("@/lib/tauri", () => ({
  isTauri: () => mockIsTauri,
  isCapacitor: () => mockIsCapacitor,
}))

// The pet overlay / popup windows load the same layout; the gate must pass
// through there so the transparent sprite window never shows a lock form.
// Default to "main" so the ordinary gate tests are unaffected.
let mockPetRole: "main" | "web" | "overlay" | "popup" = "main"
jest.mock("@/lib/pet/window-role", () => ({
  getPetWindowRole: () => mockPetRole,
  isSecondaryOverlayRole: (role: string) =>
    role === "overlay" || role === "popup" || role === "island",
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
  | "pendingRecoveryKey"
  | "createAccount"
  | "unlockAccount"
  | "acknowledgeRecoveryKey"
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
    pendingRecoveryKey: null,
    createAccount: mockCreateAccount,
    unlockAccount: mockUnlockAccount,
    acknowledgeRecoveryKey: jest.fn(),
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockIsTauri = true
  mockIsCapacitor = false
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
    expect(screen.getByRole("progressbar", { name: "page.progressLabel" })).toHaveAttribute(
      "aria-valuetext",
      "page.stages.interface"
    )
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

  it("shows a failed registry read instead of an endless loading shell", () => {
    // A settled-but-failed boot load: the store clears `loading` and records
    // the error. If the gate still keyed on `loaded === false` here, the user
    // would sit on "Loading accounts…" indefinitely and the cause would only
    // reach a console warning.
    setGateState({ loaded: true, loading: false, accounts: [], error: "registry offline" })
    render(
      <AccountGate>
        <div>child</div>
      </AccountGate>
    )
    expect(screen.queryByText("loading")).not.toBeInTheDocument()
    expect(screen.getByText("registry offline")).toBeInTheDocument()
  })

  it("shows the create-account form in an ordinary browser", () => {
    mockIsTauri = false
    setGateState({ accounts: [] })
    render(
      <AccountGate>
        <div>child</div>
      </AccountGate>
    )
    expect(screen.queryByText("child")).not.toBeInTheDocument()
    expect(screen.getByText("firstRunTitle")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "createAccount" })).toBeInTheDocument()
  })

  it("shows the unlock form in an ordinary browser", () => {
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
    expect(screen.queryByText("child")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "unlockAccount" })).toBeInTheDocument()
  })

  it("passes through to the native mobile pairing gate", () => {
    mockIsTauri = false
    mockIsCapacitor = true
    setGateState({ accounts: [] })
    render(
      <AccountGate>
        <div>child</div>
      </AccountGate>
    )
    expect(screen.getByText("child")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "createAccount" })).not.toBeInTheDocument()
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

  it("requires explicit confirmation before dismissing the one-time recovery key", () => {
    const acknowledgeRecoveryKey = jest.fn()
    setGateState({
      accounts: [account("acct_alpha", "Alpha")],
      activeAccountId: "acct_alpha",
      unlockedAccountId: "acct_alpha",
      pendingRecoveryKey: "recovery-key-once",
      acknowledgeRecoveryKey,
    })
    render(
      <AccountGate>
        <div>child</div>
      </AccountGate>
    )

    const continueButton = screen.getByRole("button", { name: "recoveryContinue" })
    expect(screen.getByText("recovery-key-once")).toBeInTheDocument()
    expect(continueButton).toBeDisabled()

    fireEvent.click(screen.getByRole("checkbox"))
    fireEvent.click(continueButton)

    expect(acknowledgeRecoveryKey).toHaveBeenCalledTimes(1)
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
