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
}))

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
})

describe("idle state", () => {
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
  })

  it("unlocks whichever account the picker names, not just the active one", async () => {
    const { props } = renderScreen({ accounts: [ALPHA, BETA] })
    fireEvent.change(screen.getByTestId("account-lock-screen-picker"), {
      target: { value: "acct_beta" },
    })
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

    fireEvent.change(screen.getByTestId("account-lock-screen-picker"), {
      target: { value: "acct_beta" },
    })
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
