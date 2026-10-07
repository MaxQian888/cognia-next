/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"

import type { LocalAccountRecord, PasswordVerifierRecord } from "@/lib/accounts/account-types"
import { AccountUnlockError } from "@/lib/accounts/account-unlock-error"
import { publishUnlockStage } from "@/lib/accounts/unlock-progress"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${Object.values(values).join(",")}` : key,
  // The lock-screen backdrop formats its clock and date through next-intl.
  useFormatter: () => ({ dateTime: (value: Date) => value.toISOString() }),
}))

let mockPlatform = "web"
let mockNativeMobile = false
const mockReadNative = jest.fn()
jest.mock("@/lib/capacitor/_shared", () => ({
  ...jest.requireActual("@/lib/capacitor/_shared"),
  isMobile: () => mockNativeMobile,
}))
jest.mock("@/lib/accounts/quick-unlock/native-biometric", () => ({
  readNativeBiometricSecret: (...args: unknown[]) => mockReadNative(...args),
}))
jest.mock("@/hooks/use-platform", () => ({ usePlatform: () => mockPlatform }))

const mockCopy = jest.fn()
jest.mock("@/hooks/ui/use-copy", () => ({
  useCopy: () => ({ copied: false, isCopying: false, copy: mockCopy }),
}))

import { AccountLockScreen } from "./account-lock-screen"

const verifier: PasswordVerifierRecord = {
  algorithm: "argon2id-v1",
  salt: "salt",
  hash: "hash",
  params: {},
}

function account(id: string, displayName: string, avatarDataUrl?: string): LocalAccountRecord {
  return { id, displayName, passwordVerifier: verifier, createdAt: 1, updatedAt: 1, avatarDataUrl }
}

const ALPHA = account("acct_alpha", "Alpha")
const BETA = account("acct_beta", "Beta")

/** A promise the test resolves by hand, so the pending state can be inspected. */
function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Pick an account from the name-as-switcher menu in the header. */
function pickAccount(name: string) {
  fireEvent.keyDown(screen.getByTestId("account-lock-screen-picker"), { key: "Enter" })
  fireEvent.click(screen.getByRole("menuitemradio", { name }))
}

function renderScreen(overrides: Partial<React.ComponentProps<typeof AccountLockScreen>> = {}) {
  const props = {
    accounts: [ALPHA],
    activeAccountId: "acct_alpha",
    onUnlock: jest.fn().mockResolvedValue(undefined),
    onRecoveryUnlock: jest.fn().mockResolvedValue(undefined),
    supportsRecoveryKey: false,
    ...overrides,
  }
  return { ...render(<AccountLockScreen {...props} />), props }
}

beforeEach(() => {
  jest.clearAllMocks()
  window.localStorage.clear()
  mockNativeMobile = false
  mockReadNative.mockReset()
})

describe("idle state", () => {
  it("uses the selected account's supported unlock methods when switching accounts", () => {
    mockNativeMobile = true
    renderScreen({
      accounts: [
        ALPHA,
        {
          ...BETA,
          quickUnlock: [{ method: "pin", verifier: {}, createdAt: 0, failedAttempts: 0 }],
        },
      ],
      onQuickUnlock: jest.fn(),
    })
    expect(screen.getByLabelText("passwordLabel")).toBeInTheDocument()
    pickAccount("Beta")
    expect(screen.getByTestId("pin-pad")).toBeInTheDocument()
    pickAccount("Alpha")
    expect(screen.getByLabelText("passwordLabel")).toBeInTheDocument()
  })

  it("lands on the password when mobile only has an unsupported web passkey", () => {
    mockNativeMobile = true
    renderScreen({
      accounts: [
        {
          ...ALPHA,
          quickUnlock: [{ method: "passkey", verifier: {}, createdAt: 0, failedAttempts: 0 }],
        },
      ],
      onQuickUnlock: jest.fn(),
    })
    expect(screen.getByLabelText("passwordLabel")).toBeInTheDocument()
    expect(screen.queryByTestId("account-lock-screen-use-quick")).not.toBeInTheDocument()
  })

  it("prompts on mobile lock entry but not when returning from password fallback", async () => {
    mockNativeMobile = true
    mockReadNative.mockResolvedValue({ ok: false, reason: "cancelled" })
    renderScreen({
      accounts: [
        {
          ...ALPHA,
          quickUnlock: [
            {
              method: "biometric",
              verifier: { nativeKeyId: "key" },
              createdAt: 0,
              failedAttempts: 0,
            },
          ],
        },
      ],
      onQuickUnlock: jest.fn(),
    })
    await waitFor(() => expect(mockReadNative).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByTestId("quick-unlock-use-password")).toBeEnabled())
    fireEvent.click(screen.getByTestId("quick-unlock-use-password"))
    expect(screen.getByLabelText("passwordLabel")).toHaveFocus()
    fireEvent.click(screen.getByTestId("account-lock-screen-use-quick"))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(mockReadNative).toHaveBeenCalledTimes(1)
  })

  it("forwards native unlock cancellation when switching the selected account during backend work", async () => {
    mockNativeMobile = true
    mockReadNative.mockResolvedValue({ ok: true, value: "biometric:synthetic-proof" })
    const pending = deferred<{ ok: boolean }>()
    const onQuickUnlock = jest.fn(() => pending.promise)
    const quickUnlock = [
      {
        method: "biometric" as const,
        verifier: { nativeKeyId: "synthetic-key" },
        createdAt: 0,
        failedAttempts: 0,
      },
    ]
    renderScreen({
      accounts: [
        { ...ALPHA, quickUnlock },
        { ...BETA, quickUnlock },
      ],
      onQuickUnlock,
    })
    fireEvent.click(screen.getByTestId("quick-unlock-biometric"))
    await waitFor(() => expect(onQuickUnlock).toHaveBeenCalledTimes(1))
    const signal = mockReadNative.mock.calls[0][0].signal as AbortSignal
    expect(onQuickUnlock).toHaveBeenCalledWith(
      "acct_alpha",
      "biometric",
      "biometric:synthetic-proof",
      signal
    )
    expect(signal.aborted).toBe(false)
    pickAccount("Beta")
    expect(signal.aborted).toBe(true)
    await act(async () => {
      pending.resolve({ ok: false })
    })
    expect(screen.getByText("unlockTitle:Beta")).toBeInTheDocument()
    expect(onQuickUnlock).toHaveBeenCalledTimes(1)
  })

  it("focuses the password field so keystrokes land somewhere", () => {
    renderScreen()
    expect(screen.getByLabelText("passwordLabel")).toHaveFocus()
  })

  it("names the account and the credential store backing it", () => {
    renderScreen({ supportsRecoveryKey: true })
    expect(screen.getByText("unlockTitle:Alpha")).toBeInTheDocument()
    expect(screen.getByText("runtimeBadgeBrowser")).toBeInTheDocument()
  })

  it("names the desktop keychain on the desktop host", () => {
    renderScreen({ supportsRecoveryKey: false })
    expect(screen.getByText("runtimeBadgeDesktop")).toBeInTheDocument()
  })

  it("names the mobile app's secure storage, not a desktop keychain, on the phone", () => {
    mockPlatform = "mobile"
    try {
      renderScreen({ supportsRecoveryKey: false })
      expect(screen.getByText("runtimeBadgeMobile")).toBeInTheDocument()
      expect(screen.queryByText("runtimeBadgeDesktop")).not.toBeInTheDocument()
    } finally {
      mockPlatform = "web"
    }
  })

  it("keeps typed text when the password field loses focus", () => {
    // Reported on device: the first entry vanished when the field blurred.
    // The field is controlled and only a successful unlock clears it.
    renderScreen()
    const field = screen.getByLabelText("passwordLabel")
    fireEvent.change(field, { target: { value: "abc123456" } })
    fireEvent.blur(field)
    expect(field).toHaveValue("abc123456")
  })

  it("unlocks with what the field shows when an IME committed it without a change event", async () => {
    // FINDINGS #4: the first attempt reported "Enter your password" because
    // state only held what React had seen, not what the keyboard committed.
    const { props } = renderScreen()
    const field = screen.getByLabelText("passwordLabel") as HTMLInputElement
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
    setValue.call(field, "abc123456")
    fireEvent.click(screen.getByTestId("account-lock-screen-submit"))
    await waitFor(() => expect(props.onUnlock).toHaveBeenCalledWith("acct_alpha", "abc123456"))
  })

  it("shows the whole display name, wrapping instead of cutting it off", () => {
    const longName = "Maxqian888 的个人工作区（测试设备）"
    renderScreen({ accounts: [account("acct_alpha", longName)] })
    const heading = screen.getByTestId("account-lock-screen-name")
    expect(heading).toHaveTextContent(longName)
    expect(heading).toHaveAttribute("title", longName)
    expect(heading).toHaveAccessibleName(`unlockTitle:${longName}`)
  })

  it("toggles the password between masked and readable", () => {
    renderScreen()
    const field = screen.getByLabelText("passwordLabel")
    expect(field).toHaveAttribute("type", "password")

    fireEvent.click(screen.getByRole("button", { name: "revealPassword" }))
    expect(field).toHaveAttribute("type", "text")

    fireEvent.click(screen.getByRole("button", { name: "hidePassword" }))
    expect(field).toHaveAttribute("type", "password")
  })

  it("warns about caps lock while typing and clears it on blur", () => {
    renderScreen()
    const field = screen.getByLabelText("passwordLabel")

    // `getModifierState` is a prototype method, so it has to be defined on the
    // event object — an init key of that name is dropped by the constructor.
    const event = new KeyboardEvent("keydown", { key: "a", bubbles: true })
    Object.defineProperty(event, "getModifierState", { value: () => true })
    fireEvent(field, event)
    expect(screen.getByText("capsLockOn")).toBeInTheDocument()

    fireEvent.blur(field)
    expect(screen.queryByText("capsLockOn")).not.toBeInTheDocument()
  })

  it("submits the typed password for the active account", async () => {
    const { props } = renderScreen()
    fireEvent.change(screen.getByLabelText("passwordLabel"), { target: { value: "secret" } })
    fireEvent.click(screen.getByTestId("account-lock-screen-submit"))

    await waitFor(() => expect(props.onUnlock).toHaveBeenCalledWith("acct_alpha", "secret"))
  })
})

describe("account selection", () => {
  it("hides the picker when there is only one account", () => {
    renderScreen()
    expect(screen.queryByTestId("account-lock-screen-picker")).not.toBeInTheDocument()
    expect(screen.getByTestId("account-lock-screen-name")).toHaveTextContent("Alpha")
  })

  it("makes the name the switcher, listing every account with the current one checked", () => {
    renderScreen({ accounts: [ALPHA, BETA] })
    const trigger = screen.getByTestId("account-lock-screen-picker")
    expect(screen.getByTestId("account-lock-screen-name")).toContainElement(trigger)
    expect(trigger).toHaveAccessibleName("switchAccountTrigger:Alpha")
    // No separate labelled select below the heading any more.
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument()

    fireEvent.keyDown(trigger, { key: "Enter" })
    expect(screen.getByText("switchAccountLabel")).toBeInTheDocument()
    expect(screen.getByRole("menuitemradio", { name: "Alpha" })).toHaveAttribute(
      "aria-checked",
      "true"
    )
    expect(screen.getByRole("menuitemradio", { name: "Beta" })).toHaveAttribute(
      "aria-checked",
      "false"
    )
  })

  it("moves focus to the password after picking an account", async () => {
    renderScreen({ accounts: [ALPHA, BETA] })
    pickAccount("Beta")
    expect(screen.getByTestId("account-lock-screen-picker")).toHaveAccessibleName(
      "switchAccountTrigger:Beta"
    )
    await waitFor(() => expect(screen.getByLabelText("passwordLabel")).toHaveFocus())
  })

  it("locks the switcher while an unlock is in flight", async () => {
    const gate = deferred()
    renderScreen({ accounts: [ALPHA, BETA], onUnlock: jest.fn().mockReturnValue(gate.promise) })
    fireEvent.change(screen.getByLabelText("passwordLabel"), { target: { value: "secret" } })
    fireEvent.click(screen.getByTestId("account-lock-screen-submit"))
    await waitFor(() => expect(screen.getByTestId("account-lock-screen-picker")).toBeDisabled())
    await act(async () => {
      gate.resolve()
    })
  })

  it("unlocks whichever account the picker names, not just the active one", async () => {
    const { props } = renderScreen({ accounts: [ALPHA, BETA] })
    pickAccount("Beta")
    expect(screen.getByText("unlockTitle:Beta")).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText("passwordLabel"), { target: { value: "other" } })
    fireEvent.click(screen.getByTestId("account-lock-screen-submit"))

    await waitFor(() => expect(props.onUnlock).toHaveBeenCalledWith("acct_beta", "other"))
  })

  it("does not carry one account's cooldown over to another", async () => {
    const onUnlock = jest.fn().mockRejectedValue(new AccountUnlockError("invalid-password"))
    renderScreen({ accounts: [ALPHA, BETA], onUnlock })

    for (let attempt = 0; attempt < 5; attempt += 1) {
      fireEvent.change(screen.getByLabelText("passwordLabel"), { target: { value: "nope" } })
      fireEvent.click(screen.getByTestId("account-lock-screen-submit"))
      await waitFor(() => expect(onUnlock).toHaveBeenCalledTimes(attempt + 1))
    }
    await screen.findByTestId("account-lock-screen-cooldown")

    pickAccount("Beta")
    expect(screen.queryByTestId("account-lock-screen-cooldown")).not.toBeInTheDocument()
  })
})

describe("pending state", () => {
  it("swaps the button label for a busy one instead of only greying out", async () => {
    const gate = deferred()
    renderScreen({ onUnlock: jest.fn().mockReturnValue(gate.promise) })

    fireEvent.click(screen.getByTestId("account-lock-screen-submit"))

    const button = await screen.findByTestId("account-lock-screen-submit")
    expect(button).toHaveTextContent("unlocking")
    expect(button).toHaveAttribute("aria-busy", "true")
    expect(screen.getByLabelText("passwordLabel")).toBeDisabled()

    await act(async () => {
      gate.resolve()
      await gate.promise
    })
  })

  it("renders the pipeline stages the desktop host actually runs", async () => {
    const gate = deferred()
    renderScreen({ onUnlock: jest.fn().mockReturnValue(gate.promise) })
    fireEvent.click(screen.getByTestId("account-lock-screen-submit"))

    const ladder = await screen.findByTestId("account-lock-screen-stages")
    expect(within(ladder).queryByText("stagePreparingRuntime")).not.toBeInTheDocument()
    expect(within(ladder).getByText("stageVerifying")).toBeInTheDocument()
    expect(within(ladder).getByText("stageOpeningDatabase")).toBeInTheDocument()

    await act(async () => {
      gate.resolve()
      await gate.promise
    })
  })

  it("adds the runtime-target stage on a Browser Vault runtime", async () => {
    const gate = deferred()
    renderScreen({ supportsRecoveryKey: true, onUnlock: jest.fn().mockReturnValue(gate.promise) })
    fireEvent.click(screen.getByTestId("account-lock-screen-submit"))

    const ladder = await screen.findByTestId("account-lock-screen-stages")
    expect(within(ladder).getByText("stagePreparingRuntime")).toBeInTheDocument()

    await act(async () => {
      gate.resolve()
      await gate.promise
    })
  })

  it("advances the ladder as the pipeline publishes stages", async () => {
    const gate = deferred()
    renderScreen({ onUnlock: jest.fn().mockReturnValue(gate.promise) })
    fireEvent.click(screen.getByTestId("account-lock-screen-submit"))
    await screen.findByTestId("account-lock-screen-stages")

    act(() => publishUnlockStage("acct_alpha", "opening-database"))

    const ladder = screen.getByTestId("account-lock-screen-stages")
    expect(ladder.querySelector('[data-stage="verifying"]')).toHaveAttribute("data-state", "done")
    expect(ladder.querySelector('[data-stage="opening-database"]')).toHaveAttribute(
      "data-state",
      "active"
    )
    expect(ladder.querySelector('[data-stage="activating"]')).toHaveAttribute(
      "data-state",
      "pending"
    )

    await act(async () => {
      gate.resolve()
      await gate.promise
    })
  })
})

describe("watchdog", () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  it("says it is slow before it says it is stuck, and only then offers the exits", async () => {
    const gate = deferred()
    renderScreen({
      onUnlock: jest.fn().mockReturnValue(gate.promise),
      slowAfterMs: 1_000,
      stuckAfterMs: 5_000,
    })
    fireEvent.click(screen.getByTestId("account-lock-screen-submit"))

    expect(screen.queryByTestId("account-lock-screen-watchdog")).not.toBeInTheDocument()

    act(() => {
      jest.advanceTimersByTime(1_500)
    })
    expect(screen.getByTestId("account-lock-screen-watchdog")).toHaveAttribute(
      "data-severity",
      "slow"
    )
    expect(screen.queryByRole("button", { name: /reloadWindow/ })).not.toBeInTheDocument()

    act(() => {
      jest.advanceTimersByTime(5_000)
    })
    expect(screen.getByTestId("account-lock-screen-watchdog")).toHaveAttribute(
      "data-severity",
      "stuck"
    )
    expect(screen.getByRole("button", { name: /reloadWindow/ })).toBeInTheDocument()

    gate.resolve()
  })

  it("lets the user stop waiting on an attempt nothing can cancel", async () => {
    const gate = deferred()
    renderScreen({
      onUnlock: jest.fn().mockReturnValue(gate.promise),
      slowAfterMs: 1_000,
      stuckAfterMs: 2_000,
    })
    fireEvent.click(screen.getByTestId("account-lock-screen-submit"))
    act(() => {
      jest.advanceTimersByTime(3_000)
    })

    fireEvent.click(screen.getByRole("button", { name: /abandonAttempt/ }))

    expect(screen.getByTestId("account-lock-screen-submit")).toHaveTextContent("unlockAccount")
    expect(screen.getByLabelText("passwordLabel")).not.toBeDisabled()

    // The abandoned promise settling later must not resurrect the pending state
    // or clobber a newer attempt — there is nothing in the pipeline to abort.
    await act(async () => {
      gate.resolve()
      await gate.promise
    })
    expect(screen.getByTestId("account-lock-screen-submit")).toHaveTextContent("unlockAccount")
  })

  it("copies a diagnostics line the user can paste into a report", async () => {
    const gate = deferred()
    renderScreen({
      onUnlock: jest.fn().mockReturnValue(gate.promise),
      slowAfterMs: 1_000,
      stuckAfterMs: 2_000,
    })
    fireEvent.click(screen.getByTestId("account-lock-screen-submit"))
    act(() => {
      jest.advanceTimersByTime(3_000)
      publishUnlockStage("acct_alpha", "opening-database")
    })

    fireEvent.click(screen.getByRole("button", { name: /copyDiagnostics/ }))

    expect(mockCopy).toHaveBeenCalledWith(expect.stringContaining("stage=opening-database"))
    expect(mockCopy).toHaveBeenCalledWith(expect.stringContaining("runtime=desktop-host"))
    gate.resolve()
  })
})

describe("failures", () => {
  it("renders a translated code, never the raw Error.message", async () => {
    renderScreen({
      onUnlock: jest.fn().mockRejectedValue(new Error("Invalid local account password.")),
    })
    fireEvent.click(screen.getByTestId("account-lock-screen-submit"))

    expect(await screen.findByText(/errorInvalidPassword/)).toBeInTheDocument()
    expect(screen.queryByText("Invalid local account password.")).not.toBeInTheDocument()
  })

  it("explains a browser opened on a desktop-created account", async () => {
    renderScreen({
      supportsRecoveryKey: true,
      onUnlock: jest.fn().mockRejectedValue(new AccountUnlockError("vault-not-provisioned")),
    })
    fireEvent.click(screen.getByTestId("account-lock-screen-submit"))

    expect(await screen.findByText("errorVaultNotProvisioned")).toBeInTheDocument()
  })

  it("counts down the remaining attempts and then blocks", async () => {
    const onUnlock = jest.fn().mockRejectedValue(new AccountUnlockError("invalid-password"))
    renderScreen({ onUnlock })

    fireEvent.click(screen.getByTestId("account-lock-screen-submit"))
    expect(await screen.findByText("attemptsRemaining:4")).toBeInTheDocument()

    for (let attempt = 1; attempt < 5; attempt += 1) {
      fireEvent.click(screen.getByTestId("account-lock-screen-submit"))
      await waitFor(() => expect(onUnlock).toHaveBeenCalledTimes(attempt + 1))
    }

    expect(await screen.findByTestId("account-lock-screen-cooldown")).toBeInTheDocument()
    expect(screen.getByTestId("account-lock-screen-submit")).toBeDisabled()
  })

  it("does not charge an attempt for a failure that is not a rejected credential", async () => {
    const onUnlock = jest.fn().mockRejectedValue(new AccountUnlockError("unknown"))
    renderScreen({ onUnlock })

    for (let attempt = 0; attempt < 6; attempt += 1) {
      fireEvent.click(screen.getByTestId("account-lock-screen-submit"))
      await waitFor(() => expect(onUnlock).toHaveBeenCalledTimes(attempt + 1))
    }

    expect(screen.queryByTestId("account-lock-screen-cooldown")).not.toBeInTheDocument()
    expect(screen.getByTestId("account-lock-screen-submit")).not.toBeDisabled()
  })

  it("clears the recorded failures once an unlock succeeds", async () => {
    const onUnlock = jest
      .fn()
      .mockRejectedValueOnce(new AccountUnlockError("invalid-password"))
      .mockResolvedValueOnce(undefined)
    renderScreen({ onUnlock })

    fireEvent.click(screen.getByTestId("account-lock-screen-submit"))
    await screen.findByText("attemptsRemaining:4")

    fireEvent.click(screen.getByTestId("account-lock-screen-submit"))
    await waitFor(() => expect(onUnlock).toHaveBeenCalledTimes(2))

    expect(window.localStorage.getItem("cognia-account-unlock-throttle:acct_alpha")).toBeNull()
  })
})

describe("recovery key", () => {
  it("offers no recovery entry point where no recovery key was ever minted", () => {
    renderScreen({ supportsRecoveryKey: false })
    expect(screen.queryByTestId("account-lock-screen-recovery-toggle")).not.toBeInTheDocument()
  })

  it("redeems a recovery key and sets a new password", async () => {
    const { props } = renderScreen({ supportsRecoveryKey: true })
    fireEvent.click(screen.getByTestId("account-lock-screen-recovery-toggle"))

    fireEvent.change(screen.getByLabelText("recoveryKeyLabel"), { target: { value: "rk-123" } })
    fireEvent.change(screen.getByLabelText("newPasswordLabel"), {
      target: { value: "brand new phrase" },
    })
    fireEvent.change(screen.getByLabelText("confirmPasswordLabel"), {
      target: { value: "brand new phrase" },
    })
    fireEvent.click(screen.getByTestId("account-lock-screen-recovery-submit"))

    await waitFor(() =>
      expect(props.onRecoveryUnlock).toHaveBeenCalledWith(
        "acct_alpha",
        "rk-123",
        "brand new phrase"
      )
    )
  })

  it("refuses a new password below the minimum length before calling the store", async () => {
    const { props } = renderScreen({ supportsRecoveryKey: true })
    fireEvent.click(screen.getByTestId("account-lock-screen-recovery-toggle"))
    fireEvent.change(screen.getByLabelText("recoveryKeyLabel"), { target: { value: "rk-123" } })
    fireEvent.change(screen.getByLabelText("newPasswordLabel"), { target: { value: "short" } })
    fireEvent.change(screen.getByLabelText("confirmPasswordLabel"), { target: { value: "short" } })
    fireEvent.click(screen.getByTestId("account-lock-screen-recovery-submit"))

    expect(await screen.findByText("passwordTooShort:8")).toBeInTheDocument()
    expect(props.onRecoveryUnlock).not.toHaveBeenCalled()
  })

  it("refuses a mismatched confirmation before calling the store", async () => {
    const { props } = renderScreen({ supportsRecoveryKey: true })
    fireEvent.click(screen.getByTestId("account-lock-screen-recovery-toggle"))
    fireEvent.change(screen.getByLabelText("recoveryKeyLabel"), { target: { value: "rk-123" } })
    fireEvent.change(screen.getByLabelText("newPasswordLabel"), {
      target: { value: "brand new phrase" },
    })
    fireEvent.change(screen.getByLabelText("confirmPasswordLabel"), {
      target: { value: "different phrase" },
    })
    fireEvent.click(screen.getByTestId("account-lock-screen-recovery-submit"))

    expect(await screen.findByText("passwordMismatch")).toBeInTheDocument()
    expect(props.onRecoveryUnlock).not.toHaveBeenCalled()
  })

  it("returns to the password form", () => {
    renderScreen({ supportsRecoveryKey: true })
    fireEvent.click(screen.getByTestId("account-lock-screen-recovery-toggle"))
    expect(screen.getByLabelText("recoveryKeyLabel")).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("account-lock-screen-recovery-toggle"))
    expect(screen.getByLabelText("passwordLabel")).toBeInTheDocument()
  })
})

describe("unsupported storage layout", () => {
  /** Drive the screen into the refusal state the way boot does. */
  async function refuse(overrides: Parameters<typeof renderScreen>[0] = {}) {
    const view = renderScreen({
      onUnlock: jest
        .fn()
        .mockRejectedValue(
          new AccountUnlockError("storage-layout-unsupported", "was not written by this build")
        ),
      ...overrides,
    })
    fireEvent.change(screen.getByLabelText("passwordLabel"), { target: { value: "pw" } })
    fireEvent.click(screen.getByTestId("account-lock-screen-submit"))
    await waitFor(() =>
      expect(screen.getByTestId("account-lock-screen-storage-layout")).toBeVisible()
    )
    return view
  }

  it("offers a reset, because no password can clear this failure", async () => {
    const onResetLocalStorage = jest.fn().mockReturnValue(new Promise(() => {}))
    jest.spyOn(window, "confirm").mockReturnValue(true)
    await refuse({ onResetLocalStorage })

    fireEvent.click(screen.getByTestId("account-lock-screen-storage-reset"))

    expect(onResetLocalStorage).toHaveBeenCalledTimes(1)
    // The button stays busy: the reset ends in a reload, not a re-render.
    await waitFor(() =>
      expect(screen.getByTestId("account-lock-screen-storage-reset")).toBeDisabled()
    )
  })

  it("replaces the unusable password form with the reset panel", async () => {
    await refuse({ onResetLocalStorage: jest.fn() })

    expect(screen.getByLabelText("passwordLabel")).not.toBeVisible()
    expect(screen.getByTestId("account-lock-screen-submit")).not.toBeVisible()
    expect(screen.getByTestId("account-lock-screen-storage-layout")).toBeVisible()
  })

  it("does not reset when the confirmation is declined", async () => {
    const onResetLocalStorage = jest.fn()
    jest.spyOn(window, "confirm").mockReturnValue(false)
    await refuse({ onResetLocalStorage })

    fireEvent.click(screen.getByTestId("account-lock-screen-storage-reset"))

    expect(onResetLocalStorage).not.toHaveBeenCalled()
  })

  it("re-enables the button when the reset itself fails", async () => {
    // Leaving it spinning forever would strand the user on a screen whose only
    // action appears to be running.
    const onResetLocalStorage = jest.fn().mockRejectedValue(new Error("delete blocked"))
    jest.spyOn(window, "confirm").mockReturnValue(true)
    await refuse({ onResetLocalStorage })

    fireEvent.click(screen.getByTestId("account-lock-screen-storage-reset"))

    await waitFor(() =>
      expect(screen.getByTestId("account-lock-screen-storage-reset")).toBeEnabled()
    )
  })

  it("shows no reset panel for an ordinary wrong password", async () => {
    renderScreen({
      onUnlock: jest.fn().mockRejectedValue(new AccountUnlockError("invalid-password")),
      onResetLocalStorage: jest.fn(),
    })
    fireEvent.change(screen.getByLabelText("passwordLabel"), { target: { value: "pw" } })
    fireEvent.click(screen.getByTestId("account-lock-screen-submit"))

    await waitFor(() => expect(screen.getByText("errorInvalidPassword")).toBeVisible())
    expect(screen.queryByTestId("account-lock-screen-storage-layout")).not.toBeInTheDocument()
  })
})

describe("unlock automatically on this device", () => {
  const REMEMBERED: LocalAccountRecord = { ...ALPHA, rememberOnDevice: true }
  const LOCAL: LocalAccountRecord = {
    ...account("acct_desktop_local_workspace", "Local"),
    protection: "device",
  }

  function submitWith(password: string) {
    fireEvent.change(screen.getByLabelText("passwordLabel"), { target: { value: password } })
    fireEvent.click(screen.getByTestId("account-lock-screen-submit"))
  }

  it("is not offered where the runtime cannot keep a secret", () => {
    renderScreen()
    expect(screen.queryByTestId("account-lock-screen-remember")).not.toBeInTheDocument()
  })

  it("sends the choice when the owner ticks it", async () => {
    const { props } = renderScreen({ supportsRememberOnDevice: true })
    const checkbox = screen.getByTestId("account-lock-screen-remember")
    expect(checkbox).not.toBeChecked()

    fireEvent.click(checkbox)
    submitWith("secret")

    await waitFor(() =>
      expect(props.onUnlock).toHaveBeenCalledWith("acct_alpha", "secret", {
        rememberOnDevice: true,
      })
    )
  })

  it("sends nothing when the choice is left as it was", async () => {
    const { props } = renderScreen({ supportsRememberOnDevice: true, accounts: [REMEMBERED] })
    expect(screen.getByTestId("account-lock-screen-remember")).toBeChecked()

    submitWith("secret")

    await waitFor(() => expect(props.onUnlock).toHaveBeenCalledWith("acct_alpha", "secret"))
  })

  it("sends `false` when the owner unticks a remembered profile", async () => {
    const { props } = renderScreen({ supportsRememberOnDevice: true, accounts: [REMEMBERED] })

    fireEvent.click(screen.getByTestId("account-lock-screen-remember"))
    submitWith("secret")

    await waitFor(() =>
      expect(props.onUnlock).toHaveBeenCalledWith("acct_alpha", "secret", {
        rememberOnDevice: false,
      })
    )
  })

  it("follows the picked account's own setting", () => {
    renderScreen({ supportsRememberOnDevice: true, accounts: [REMEMBERED, BETA] })
    expect(screen.getByTestId("account-lock-screen-remember")).toBeChecked()

    pickAccount("Beta")

    expect(screen.getByTestId("account-lock-screen-remember")).not.toBeChecked()
  })

  it("asks for no password for the device-managed workspace and just opens it", async () => {
    const { props } = renderScreen({
      supportsRememberOnDevice: true,
      accounts: [LOCAL],
      activeAccountId: LOCAL.id,
    })

    expect(screen.getByLabelText("passwordLabel").closest("[hidden]")).not.toBeNull()
    expect(screen.queryByTestId("account-lock-screen-remember")).not.toBeInTheDocument()
    expect(screen.getByTestId("account-lock-screen-device")).toHaveTextContent(
      "deviceWorkspaceHint"
    )
    const open = screen.getByTestId("account-lock-screen-submit")
    expect(open).toHaveTextContent("openLocalWorkspace")

    fireEvent.click(open)

    await waitFor(() => expect(props.onUnlock).toHaveBeenCalledWith(LOCAL.id, ""))
  })

  it("explains why boot could not open the profile by itself", () => {
    renderScreen({
      supportsRememberOnDevice: true,
      accounts: [REMEMBERED],
      autoUnlockFailure: {
        accountId: "acct_alpha",
        reason: "secret-store-unavailable",
        message: "SECRET_STORE_LOCKED: denied",
      },
    })

    const notice = screen.getByTestId("account-lock-screen-auto-unlock-failure")
    expect(notice).toHaveTextContent("autoUnlockFailedTitle")
    expect(notice).toHaveTextContent("autoUnlockFailedStore")
    expect(notice).toHaveTextContent("SECRET_STORE_LOCKED: denied")
  })

  it("keeps the notice to the profile it is about", () => {
    renderScreen({
      supportsRememberOnDevice: true,
      accounts: [ALPHA, BETA],
      activeAccountId: "acct_beta",
      autoUnlockFailure: { accountId: "acct_alpha", reason: "secret-rejected" },
    })

    expect(screen.queryByTestId("account-lock-screen-auto-unlock-failure")).not.toBeInTheDocument()
  })

  it.each([
    ["secret-missing", "autoUnlockFailedMissing"],
    ["secret-rejected", "autoUnlockFailedRejected"],
    ["unlock-failed", "autoUnlockFailedOther"],
  ] as const)("names the %s failure", (reason, key) => {
    renderScreen({
      supportsRememberOnDevice: true,
      autoUnlockFailure: { accountId: "acct_alpha", reason },
    })
    expect(screen.getByTestId("account-lock-screen-auto-unlock-failure")).toHaveTextContent(key)
  })

  it("translates a store that refused the secret into its own message", async () => {
    renderScreen({
      supportsRememberOnDevice: true,
      onUnlock: jest
        .fn()
        .mockRejectedValue(new AccountUnlockError("secret-store-unavailable", "keychain denied")),
    })

    fireEvent.click(screen.getByTestId("account-lock-screen-remember"))
    submitWith("secret")

    await waitFor(() => expect(screen.getByText("errorSecretStoreUnavailable")).toBeVisible())
    expect(screen.queryByText("keychain denied")).not.toBeInTheDocument()
  })
})
