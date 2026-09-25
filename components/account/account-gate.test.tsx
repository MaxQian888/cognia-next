/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { LocalAccountRecord, PasswordVerifierRecord } from "@/lib/accounts/account-types"
import type { AccountStoreState } from "@/stores/account/account-store"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, string>) =>
    values ? `${key}:${Object.values(values).join(",")}` : key,
  // The lock-screen backdrop formats its clock and date through next-intl.
  useFormatter: () => ({ dateTime: (value: Date) => value.toISOString() }),
}))

// The share viewer route is the one place the gate hands a reader with no
// open account a guest view instead of a gate screen. Default to the app root
// so the ordinary gate tests are unaffected.
let mockPathname: string | null = "/"
jest.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
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

// The explicit, prompt-allowed secret-store unlock. Never reached by a
// silent retry, only by the device screen's "allow access" action.
const mockUnlockSecretStore = jest.fn<Promise<null>, []>()
jest.mock("@/lib/tauri/recovery", () => ({
  unlockSecretStore: () => mockUnlockSecretStore(),
}))

const mockCreateAccount = jest.fn<Promise<LocalAccountRecord>, [unknown]>()
const mockUnlockAccount = jest.fn<Promise<void>, [string, string]>()
const mockUnlockWithRecoveryKey = jest.fn<Promise<void>, [string, string, string]>()
const mockUsesBrowserVault = false

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
  | "autoUnlockFailure"
  | "createAccount"
  | "unlockAccount"
  | "unlockAccountWithRecoveryKey"
  | "acknowledgeRecoveryKey"
>

jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: (selector: (state: typeof mockState) => unknown) => selector(mockState),
  selectActiveAccount: (state: typeof mockState) =>
    state.accounts.find((account) => account.id === state.activeAccountId) ?? null,
  usesBrowserVault: () => mockUsesBrowserVault,
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
    autoUnlockFailure: null,
    createAccount: mockCreateAccount,
    unlockAccount: mockUnlockAccount,
    unlockAccountWithRecoveryKey: mockUnlockWithRecoveryKey,
    acknowledgeRecoveryKey: jest.fn(),
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockIsTauri = true
  mockIsCapacitor = false
  mockPetRole = "main"
  mockPathname = "/"
  mockCreateAccount.mockResolvedValue(account("acct_first", "First"))
  mockUnlockAccount.mockResolvedValue()
  mockUnlockSecretStore.mockResolvedValue(null)
  setGateState()
})

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
})

describe("AccountGate", () => {
  it("renders a loading state while the registry has not hydrated", () => {
    setGateState({ loaded: false, loading: true })
    render(
      <AccountGate>
        <div>child</div>
      </AccountGate>
    )
    // The boot screen, standing for its `accounts` milestone.
    expect(screen.getByRole("heading", { name: "title" })).toBeInTheDocument()
    expect(screen.getByRole("progressbar", { name: "progressLabel" })).toHaveAttribute(
      "aria-valuetext",
      "milestones.accounts.label"
    )
    expect(document.querySelector('[data-slot="boot-screen"]')).toHaveAttribute(
      "data-milestone",
      "accounts"
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
    expect(screen.getByRole("heading", { name: "title" })).toBeInTheDocument()
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
    expect(screen.queryByRole("heading", { name: "title" })).not.toBeInTheDocument()
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

  it("copies the one-time recovery key from the recovery screen", async () => {
    const writeText = jest.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    })
    setGateState({
      accounts: [account("acct_alpha", "Alpha")],
      activeAccountId: "acct_alpha",
      unlockedAccountId: "acct_alpha",
      pendingRecoveryKey: "recovery-key-once",
    })

    render(
      <AccountGate>
        <div>child</div>
      </AccountGate>
    )

    fireEvent.click(screen.getByRole("button", { name: "recoveryCopy" }))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("recovery-key-once"))
    expect(screen.getByRole("button", { name: "recoveryCopied" })).toBeInTheDocument()
  })

  it("downloads the one-time recovery key as a local text file", () => {
    const createObjectURL = jest.fn(() => "blob:recovery-key")
    const revokeObjectURL = jest.fn()
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectURL,
    })
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectURL,
    })
    const click = jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})
    setGateState({
      accounts: [account("acct_alpha", "Alpha")],
      activeAccountId: "acct_alpha",
      unlockedAccountId: "acct_alpha",
      pendingRecoveryKey: "recovery-key-once",
    })

    render(
      <AccountGate>
        <div>child</div>
      </AccountGate>
    )

    fireEvent.click(screen.getByRole("button", { name: "recoveryDownload" }))

    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob))
    expect(click).toHaveBeenCalledTimes(1)
    expect(click.mock.instances[0]).toMatchObject({
      download: "cognia-recovery-key.txt",
      href: "blob:recovery-key",
    })
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:recovery-key")
    click.mockRestore()
  })

  it("does not dismiss recovery until first-account runtime activation finishes", async () => {
    let resolveCreate!: (account: LocalAccountRecord) => void
    mockCreateAccount.mockReturnValueOnce(
      new Promise<LocalAccountRecord>((resolve) => {
        resolveCreate = resolve
      })
    )
    const view = render(
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
    await waitFor(() => expect(mockCreateAccount).toHaveBeenCalledTimes(1))

    setGateState({
      accounts: [account("acct_first", "First")],
      activeAccountId: "acct_first",
      unlockedAccountId: "acct_first",
      pendingRecoveryKey: "recovery-key-once",
    })
    view.rerender(
      <AccountGate>
        <div>child</div>
      </AccountGate>
    )

    expect(screen.getByRole("checkbox")).toBeDisabled()
    expect(screen.getByRole("button", { name: "recoveryContinue" })).toBeDisabled()

    await act(async () => resolveCreate(account("acct_first", "First")))

    await waitFor(() => expect(screen.getByRole("checkbox")).toBeEnabled())
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

  // The lock screen renders a TRANSLATED error code, not the raw `Error.message`
  // the store carries — that is the point of the change. `state.error` still
  // reaches the first-run and recovery-handover forms, which own it.
  it("lets the lock screen own its own failure copy", async () => {
    const alpha = account("acct_alpha", "Alpha")
    mockUnlockAccount.mockRejectedValueOnce(new Error("Invalid local account password."))
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

    expect(screen.queryByText("previous error")).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText("passwordLabel"), {
      target: { value: "bad" },
    })
    fireEvent.click(screen.getByRole("button", { name: "unlockAccount" }))

    await screen.findByText("errorInvalidPassword")
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

it("retries the device workspace without requesting an unknown password", async () => {
  const device = {
    ...account("acct_desktop_local_workspace", "Local"),
    protection: "device" as const,
  }
  setGateState({ accounts: [device], activeAccountId: device.id, locked: true })
  render(
    <AccountGate>
      <div>workspace</div>
    </AccountGate>
  )
  expect(screen.queryByLabelText("passwordLabel")).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "openLocalWorkspace" }))
  await waitFor(() => expect(mockUnlockAccount).toHaveBeenCalledWith(device.id, ""))
})

describe("device-managed workspace screen", () => {
  const device = {
    ...account("acct_desktop_local_workspace", "Local"),
    protection: "device" as const,
  }

  function renderGate() {
    render(
      <AccountGate>
        <div>workspace</div>
      </AccountGate>
    )
  }

  it("says the workspace is locked, not that it failed, when nothing went wrong", () => {
    setGateState({ accounts: [device], activeAccountId: device.id, locked: true })
    renderGate()
    expect(screen.getByText("localWorkspaceLocked")).toBeInTheDocument()
    expect(screen.queryByText("localWorkspaceUnavailable")).not.toBeInTheDocument()
    expect(screen.getByTestId("account-device-workspace-open")).toHaveTextContent(
      "openLocalWorkspace"
    )
  })

  it("offers the prompt-allowed credential store unlock when that store is the blocker", async () => {
    setGateState({
      accounts: [device],
      activeAccountId: device.id,
      locked: true,
      error: "SECRET_STORE_LOCKED: master key read: Platform failure",
    })
    renderGate()
    expect(screen.getByText("localWorkspaceUnavailable")).toBeInTheDocument()
    const allow = screen.getByTestId("account-device-workspace-open")
    expect(allow).toHaveTextContent("allowCredentialStoreAccess")

    fireEvent.click(allow)

    await waitFor(() => expect(mockUnlockAccount).toHaveBeenCalledWith(device.id, ""))
    expect(mockUnlockSecretStore).toHaveBeenCalledTimes(1)
    expect(mockUnlockSecretStore.mock.invocationCallOrder[0]).toBeLessThan(
      mockUnlockAccount.mock.invocationCallOrder[0]!
    )
  })

  it("does not open the OS prompt for a failure that is not the credential store's", async () => {
    setGateState({
      accounts: [device],
      activeAccountId: device.id,
      locked: true,
      error: "The local workspace vault is missing.",
    })
    renderGate()
    fireEvent.click(screen.getByRole("button", { name: "openLocalWorkspace" }))
    await waitFor(() => expect(mockUnlockAccount).toHaveBeenCalledWith(device.id, ""))
    expect(mockUnlockSecretStore).not.toHaveBeenCalled()
  })

  it("stays on the screen and shows why when the store is still refused", async () => {
    setGateState({
      accounts: [device],
      activeAccountId: device.id,
      locked: true,
      error: "SECRET_STORE_LOCKED: denied",
    })
    mockUnlockSecretStore.mockRejectedValue(new Error("user cancelled the keychain prompt"))
    renderGate()
    fireEvent.click(screen.getByTestId("account-device-workspace-open"))
    await waitFor(() =>
      expect(screen.getByText("user cancelled the keychain prompt")).toBeInTheDocument()
    )
    expect(mockUnlockAccount).not.toHaveBeenCalled()
  })
})

describe("lock screen wiring for automatic unlock", () => {
  const alpha = account("acct_alpha", "Alpha")

  it("offers the choice in the desktop shell and hands over boot's failure", () => {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    setGateState({
      accounts: [alpha],
      activeAccountId: alpha.id,
      locked: true,
      autoUnlockFailure: { accountId: alpha.id, reason: "secret-missing" },
    })
    render(
      <AccountGate>
        <div>workspace</div>
      </AccountGate>
    )
    expect(screen.getByTestId("account-lock-screen-remember")).toBeInTheDocument()
    expect(screen.getByTestId("account-lock-screen-auto-unlock-failure")).toHaveTextContent(
      "autoUnlockFailedMissing"
    )
  })

  it("does not offer it in a browser", () => {
    setGateState({ accounts: [alpha], activeAccountId: alpha.id, locked: true })
    render(
      <AccountGate>
        <div>workspace</div>
      </AccountGate>
    )
    expect(screen.queryByTestId("account-lock-screen-remember")).not.toBeInTheDocument()
  })
})

// ADR-0037, "The anonymous visitor". `/share/view` renders for anyone holding
// the link, and on the public deployment that is a fresh browser with no
// account at all. The gate must neither stand in front of the link nor send
// the visitor through account creation, whose hand-off to onboarding leaves the
// page and drops the `#k=` key.
describe("share viewer route", () => {
  const alpha = account("acct_alpha", "Alpha")

  function renderShareRoute(options: { guestView?: boolean } = {}) {
    const { guestView = true } = options
    return render(
      <AccountGate guestView={guestView ? <div>guest viewer</div> : undefined}>
        <div>app viewer</div>
      </AccountGate>
    )
  }

  beforeEach(() => {
    mockIsTauri = false
    mockPathname = "/share/view"
  })

  it.each(["/share/view", "/share/view/", "/share/view.html"])(
    "shows a fresh browser the guest viewer, not the first-run form, at %s",
    (route) => {
      mockPathname = route
      setGateState({ accounts: [] })
      renderShareRoute()
      expect(screen.getByText("guest viewer")).toBeInTheDocument()
      expect(screen.queryByText("app viewer")).not.toBeInTheDocument()
      expect(screen.queryByText("firstRunTitle")).not.toBeInTheDocument()
      expect(screen.queryByRole("button", { name: "createAccount" })).not.toBeInTheDocument()
    }
  )

  // The decision waits for every automatic unlock boot runs (desktop
  // workspace, remembered profile, tab session), so an owner is never shown the
  // guest view first and then switched, which would fetch the share twice.
  it("decides nothing until the registry has settled", () => {
    setGateState({ accounts: [], loaded: false, loading: true })
    renderShareRoute()
    expect(screen.queryByText("guest viewer")).not.toBeInTheDocument()
    expect(screen.queryByText("app viewer")).not.toBeInTheDocument()
    expect(screen.getByRole("progressbar", { name: "progressLabel" })).toBeInTheDocument()
  })

  it("keeps the owner's open account in the app, where the import actions are", () => {
    setGateState({
      accounts: [alpha],
      activeAccountId: alpha.id,
      unlockedAccountId: alpha.id,
      locked: false,
    })
    renderShareRoute()
    expect(screen.getByText("app viewer")).toBeInTheDocument()
    expect(screen.queryByText("guest viewer")).not.toBeInTheDocument()
  })

  it("puts unlocking first when this browser has an account, with reading as a guest beside it", () => {
    setGateState({ accounts: [alpha], activeAccountId: alpha.id, locked: true })
    renderShareRoute()
    expect(screen.getByRole("button", { name: "unlockAccount" })).toBeInTheDocument()
    expect(screen.getByText("shareGuestHint")).toBeInTheDocument()
    expect(screen.getByTestId("account-gate-read-share-as-guest")).toHaveTextContent(
      "shareGuestAction"
    )
    expect(screen.queryByText("guest viewer")).not.toBeInTheDocument()
    expect(screen.queryByText("app viewer")).not.toBeInTheDocument()
  })

  it("switches to the guest viewer when the reader chooses not to unlock", () => {
    setGateState({ accounts: [alpha], activeAccountId: alpha.id, locked: true })
    renderShareRoute()
    fireEvent.click(screen.getByTestId("account-gate-read-share-as-guest"))
    expect(screen.getByText("guest viewer")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "unlockAccount" })).not.toBeInTheDocument()
    expect(mockUnlockAccount).not.toHaveBeenCalled()
  })

  it("offers the same choice on the device-managed workspace screen", () => {
    const device = {
      ...account("acct_desktop_local_workspace", "Local"),
      protection: "device" as const,
    }
    setGateState({ accounts: [device], activeAccountId: device.id, locked: true })
    renderShareRoute()
    expect(screen.getByTestId("account-device-workspace-open")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("account-gate-read-share-as-guest"))
    expect(screen.getByText("guest viewer")).toBeInTheDocument()
  })

  // The choice answers the unlock screen. Once an account is open (unlocked
  // from another route, say), the app is the right thing to show again.
  it("hands back to the app once an account is open, even after reading as a guest", () => {
    setGateState({ accounts: [alpha], activeAccountId: alpha.id, locked: true })
    const { rerender } = renderShareRoute()
    fireEvent.click(screen.getByTestId("account-gate-read-share-as-guest"))
    expect(screen.getByText("guest viewer")).toBeInTheDocument()

    setGateState({
      accounts: [alpha],
      activeAccountId: alpha.id,
      unlockedAccountId: alpha.id,
      locked: false,
    })
    rerender(
      <AccountGate guestView={<div>guest viewer</div>}>
        <div>app viewer</div>
      </AccountGate>
    )
    expect(screen.getByText("app viewer")).toBeInTheDocument()
    expect(screen.queryByText("guest viewer")).not.toBeInTheDocument()
  })

  // The one-time recovery key is shown once and cannot be recovered later, so
  // nothing may paint over it, the guest view included. An empty registry is
  // the state in which the guest branch would otherwise win, so this fails if
  // the share route is ever checked before the hand-over.
  it("never skips the one-time recovery key hand-over", () => {
    setGateState({ accounts: [], pendingRecoveryKey: "ABCD-EFGH" })
    renderShareRoute()
    expect(screen.getByTestId("account-vault-recovery")).toBeInTheDocument()
    expect(screen.queryByText("guest viewer")).not.toBeInTheDocument()
  })

  it("leaves native mobile to its own pairing gate", () => {
    mockIsCapacitor = true
    setGateState({ accounts: [] })
    renderShareRoute()
    expect(screen.getByText("app viewer")).toBeInTheDocument()
    expect(screen.queryByText("guest viewer")).not.toBeInTheDocument()
  })

  it("is the ordinary gate on any other route", () => {
    mockPathname = "/settings"
    setGateState({ accounts: [] })
    renderShareRoute()
    expect(screen.getByText("firstRunTitle")).toBeInTheDocument()
    expect(screen.queryByText("guest viewer")).not.toBeInTheDocument()
  })

  it("is the ordinary gate when the layout supplies no guest view", () => {
    setGateState({ accounts: [alpha], activeAccountId: alpha.id, locked: true })
    renderShareRoute({ guestView: false })
    expect(screen.getByRole("button", { name: "unlockAccount" })).toBeInTheDocument()
    expect(screen.queryByTestId("account-gate-read-share-as-guest")).not.toBeInTheDocument()
  })

  it("does not offer reading as a guest on the unlock screen of any other route", () => {
    mockPathname = "/"
    setGateState({ accounts: [alpha], activeAccountId: alpha.id, locked: true })
    renderShareRoute()
    expect(screen.getByRole("button", { name: "unlockAccount" })).toBeInTheDocument()
    expect(screen.queryByTestId("account-gate-read-share-as-guest")).not.toBeInTheDocument()
  })
})
