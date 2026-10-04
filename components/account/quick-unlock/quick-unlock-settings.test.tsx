/** @jest-environment jsdom */

import { act, fireEvent, render, screen } from "@testing-library/react"

import { QuickUnlockSettings } from "./quick-unlock-settings"
import {
  MAX_QUICK_UNLOCK_ATTEMPTS,
  type QuickUnlockEnrollment,
} from "@/lib/accounts/quick-unlock/types"
import type { LocalAccountRecord } from "@/lib/accounts/account-types"

jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) =>
    values ? `${namespace}.${key}:${JSON.stringify(values)}` : `${namespace}.${key}`,
}))

let passkeySupported = true
let mockMobile = false
const mockNativeEnrollment = jest.fn()
jest.mock("@/lib/capacitor/_shared", () => ({
  ...jest.requireActual("@/lib/capacitor/_shared"),
  isMobile: () => mockMobile,
}))
jest.mock("@/lib/accounts/quick-unlock/native-biometric", () => ({
  enrollNativeBiometric: (...args: unknown[]) => mockNativeEnrollment(...args),
}))
const enrollPasskey = jest.fn()
jest.mock("@/lib/accounts/quick-unlock/passkey", () => ({
  isPasskeySupported: () => passkeySupported,
  enrollPasskey: (...a: unknown[]) => enrollPasskey(...a),
  canonicalizePasskeySecret: (bytes: Uint8Array) => `passkey:${bytes.length}`,
}))

function account(quickUnlock?: QuickUnlockEnrollment[]): LocalAccountRecord {
  return {
    id: "acct-001",
    displayName: "Ada",
    passwordVerifier: { algorithm: "a", salt: "s", hash: "h", params: {} },
    createdAt: 0,
    updatedAt: 0,
    ...(quickUnlock ? { quickUnlock } : {}),
  }
}

function enrollment(patch: Partial<QuickUnlockEnrollment> = {}): QuickUnlockEnrollment {
  return { method: "pin", verifier: {}, createdAt: 0, failedAttempts: 0, ...patch }
}

function renderSettings(record = account()) {
  const onEnroll = jest.fn(async () => {})
  const onRemove = jest.fn(async () => {})
  const onClearLockout = jest.fn(async () => {})
  render(
    <QuickUnlockSettings
      account={record}
      onEnroll={onEnroll}
      onRemove={onRemove}
      onClearLockout={onClearLockout}
    />
  )
  return { onEnroll, onRemove, onClearLockout }
}

function typePassword(value = "hunter2hunter2"): void {
  fireEvent.change(screen.getByTestId("quick-unlock-password"), { target: { value } })
}

function enterPin(prefix: string, pin: string): void {
  for (const digit of pin) fireEvent.click(screen.getByTestId(`${prefix}-key-${digit}`))
  fireEvent.click(screen.getByTestId(`${prefix}-submit`))
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  passkeySupported = true
  mockMobile = false
  mockNativeEnrollment.mockReset()
})

describe("QuickUnlockSettings", () => {
  it("offers native biometrics only on mobile and does not offer passkeys there", () => {
    mockMobile = true
    renderSettings()
    expect(screen.getByTestId("quick-unlock-add-biometric")).toBeDisabled()
    expect(screen.queryByTestId("quick-unlock-add-passkey")).not.toBeInTheDocument()
    typePassword()
    expect(screen.getByTestId("quick-unlock-add-biometric")).toBeEnabled()
  })

  it("does not offer native biometrics on desktop or web", () => {
    renderSettings()
    expect(screen.queryByTestId("quick-unlock-add-biometric")).not.toBeInTheDocument()
    expect(screen.getByTestId("quick-unlock-add-passkey")).toBeInTheDocument()
  })

  it("passes protected native key material and metadata to password-validated enrollment", async () => {
    mockMobile = true
    mockNativeEnrollment.mockImplementation(async ({ commit }) => {
      await commit("biometric:protected-secret", "account-scoped-key-id")
      return { ok: true }
    })
    const { onEnroll } = renderSettings()
    typePassword("account-password")
    fireEvent.click(screen.getByTestId("quick-unlock-add-biometric"))
    fireEvent.click(screen.getByTestId("quick-unlock-enroll-biometric"))
    await flush()
    expect(mockNativeEnrollment).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acct-001",
        prompt: expect.objectContaining({
          title: expect.any(String),
          reason: expect.any(String),
          negativeButtonText: expect.any(String),
        }),
      })
    )
    expect(onEnroll).toHaveBeenCalledWith({
      accountId: "acct-001",
      method: "biometric",
      canonicalSecret: "biometric:protected-secret",
      password: "account-password",
      verifier: { nativeKeyId: "account-scoped-key-id" },
      signal: mockNativeEnrollment.mock.calls[0][0].signal,
    })
    expect(screen.getByTestId("quick-unlock-password")).toHaveValue("")
    expect(screen.queryByTestId("quick-unlock-draft")).not.toBeInTheDocument()
  })

  it.each(["cancelled", "failed", "lockout", "unavailable"])(
    "does not enroll when native biometric setup is %s",
    async (reason) => {
      mockMobile = true
      mockNativeEnrollment.mockResolvedValue({ ok: false, reason })
      const { onEnroll } = renderSettings()
      typePassword()
      fireEvent.click(screen.getByTestId("quick-unlock-add-biometric"))
      fireEvent.click(screen.getByTestId("quick-unlock-enroll-biometric"))
      await flush()
      expect(onEnroll).not.toHaveBeenCalled()
      expect(screen.getByRole("alert")).toHaveTextContent(`biometricFailure.${reason}`)
      expect(screen.getByTestId("quick-unlock-cancel")).toBeEnabled()
    }
  )

  it("reports an unexpected native rejection and releases the setup controls", async () => {
    mockMobile = true
    mockNativeEnrollment.mockRejectedValue(new Error("native rejected"))
    renderSettings()
    typePassword()
    fireEvent.click(screen.getByTestId("quick-unlock-add-biometric"))
    fireEvent.click(screen.getByTestId("quick-unlock-enroll-biometric"))
    await flush()
    expect(screen.getByRole("alert")).toHaveTextContent("enrollFailed")
    expect(screen.getByTestId("quick-unlock-enroll-biometric")).toBeEnabled()
  })

  it("does not commit a native candidate after switching accounts", async () => {
    mockMobile = true
    let commit!: (secret: string, keyId: string) => Promise<void>
    let finish!: (value: unknown) => void
    mockNativeEnrollment.mockImplementation((args) => {
      commit = args.commit
      return new Promise((resolve) => {
        finish = resolve
      })
    })
    const onEnroll = jest.fn(async () => {})
    const props = { account: account(), onEnroll, onRemove: jest.fn(), onClearLockout: jest.fn() }
    const { rerender } = render(<QuickUnlockSettings {...props} />)
    typePassword()
    fireEvent.click(screen.getByTestId("quick-unlock-add-biometric"))
    fireEvent.click(screen.getByTestId("quick-unlock-enroll-biometric"))
    rerender(<QuickUnlockSettings {...props} account={{ ...account(), id: "acct-002" }} />)
    await expect(commit("protected-secret", "candidate-key")).rejects.toThrow()
    await act(async () => {
      finish({ ok: false, reason: "failed" })
    })
    expect(onEnroll).not.toHaveBeenCalled()
    expect(screen.getByTestId("quick-unlock-password")).toHaveValue("")
  })

  it("aborts backend enrollment verification when its account UI unmounts", async () => {
    mockMobile = true
    mockNativeEnrollment.mockImplementation(async ({ commit }) => {
      await commit("protected-secret", "candidate-key")
      return { ok: true }
    })
    let finish!: () => void
    const onEnroll = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    const { unmount } = render(
      <QuickUnlockSettings
        account={account()}
        onEnroll={onEnroll}
        onRemove={jest.fn()}
        onClearLockout={jest.fn()}
      />
    )
    typePassword()
    fireEvent.click(screen.getByTestId("quick-unlock-add-biometric"))
    fireEvent.click(screen.getByTestId("quick-unlock-enroll-biometric"))
    await flush()
    const signal = mockNativeEnrollment.mock.calls[0][0].signal as AbortSignal
    expect(onEnroll).toHaveBeenCalledWith(expect.objectContaining({ signal }))
    expect(signal.aborted).toBe(false)
    unmount()
    expect(signal.aborted).toBe(true)
    await act(async () => {
      finish()
    })
  })

  it("requires the account password even after opening the native enrollment draft", () => {
    mockMobile = true
    renderSettings()
    typePassword()
    fireEvent.click(screen.getByTestId("quick-unlock-add-biometric"))
    typePassword("")
    expect(screen.getByTestId("quick-unlock-enroll-biometric")).toBeDisabled()
    expect(mockNativeEnrollment).not.toHaveBeenCalled()
  })

  it("does not complete enrollment when backend password verification fails", async () => {
    mockMobile = true
    mockNativeEnrollment.mockImplementation(async ({ commit }) => {
      try {
        await commit("protected-secret", "candidate-key")
        return { ok: true }
      } catch {
        return { ok: false, reason: "failed" }
      }
    })
    const onEnroll = jest.fn(async () => {
      throw new Error("Invalid password")
    })
    render(
      <QuickUnlockSettings
        account={account()}
        onEnroll={onEnroll}
        onRemove={jest.fn()}
        onClearLockout={jest.fn()}
      />
    )
    typePassword("wrong-password")
    fireEvent.click(screen.getByTestId("quick-unlock-add-biometric"))
    fireEvent.click(screen.getByTestId("quick-unlock-enroll-biometric"))
    await flush()
    expect(onEnroll).toHaveBeenCalledWith(expect.objectContaining({ password: "wrong-password" }))
    expect(screen.getByRole("alert")).toHaveTextContent("biometricFailure.failed")
    expect(screen.getByTestId("quick-unlock-draft")).toBeInTheDocument()
  })

  it("aborts native enrollment on unmount so a late candidate cannot be committed", async () => {
    mockMobile = true
    let request!: { signal: AbortSignal; commit: (secret: string, key: string) => Promise<void> }
    let finish!: (value: unknown) => void
    mockNativeEnrollment.mockImplementation((args) => {
      request = args
      return new Promise((resolve) => {
        finish = resolve
      })
    })
    const onEnroll = jest.fn()
    const { unmount } = render(
      <QuickUnlockSettings
        account={account()}
        onEnroll={onEnroll}
        onRemove={jest.fn()}
        onClearLockout={jest.fn()}
      />
    )
    typePassword()
    fireEvent.click(screen.getByTestId("quick-unlock-add-biometric"))
    fireEvent.click(screen.getByTestId("quick-unlock-enroll-biometric"))
    unmount()
    expect(request.signal.aborted).toBe(true)
    await expect(request.commit("secret", "candidate-key")).rejects.toThrow("cancelled")
    await act(async () => {
      finish({ ok: false, reason: "cancelled" })
    })
    expect(onEnroll).not.toHaveBeenCalled()
  })

  it("says when nothing is set up", () => {
    renderSettings()
    expect(screen.getByText(/settings.none/)).toBeInTheDocument()
  })

  it("requires the password before any method can be added", () => {
    // Adding a method mints a new way into the account. A signed-in laptop
    // left on a desk must not be enough for a passer-by to add their own PIN.
    renderSettings()
    expect(screen.getByTestId("quick-unlock-add-pin")).toBeDisabled()
    typePassword()
    expect(screen.getByTestId("quick-unlock-add-pin")).not.toBeDisabled()
  })

  it("hides passkey where the platform has no WebAuthn", () => {
    // Disabled would imply a fix exists. There is nothing the user could do.
    passkeySupported = false
    renderSettings()
    expect(screen.queryByTestId("quick-unlock-add-passkey")).not.toBeInTheDocument()
    expect(screen.getByTestId("quick-unlock-add-pin")).toBeInTheDocument()
  })

  it("enrolls a PIN only after it is entered twice", async () => {
    const { onEnroll } = renderSettings()
    typePassword()
    fireEvent.click(screen.getByTestId("quick-unlock-add-pin"))

    enterPin("enroll-pin", "428193")
    expect(onEnroll).not.toHaveBeenCalled()
    expect(screen.getByTestId("quick-unlock-draft-step")).toHaveTextContent("pinConfirm")

    enterPin("enroll-pin", "428193")
    await flush()
    expect(onEnroll).toHaveBeenCalledWith(
      expect.objectContaining({ method: "pin", canonicalSecret: "pin:428193" })
    )
  })

  it("restarts when the confirmation does not match", async () => {
    // A typo at enrollment would otherwise only surface at the next lock, by
    // which point the correct value is unknowable.
    const { onEnroll } = renderSettings()
    typePassword()
    fireEvent.click(screen.getByTestId("quick-unlock-add-pin"))

    enterPin("enroll-pin", "428193")
    enterPin("enroll-pin", "428194")
    await flush()

    expect(onEnroll).not.toHaveBeenCalled()
    expect(screen.getByRole("alert")).toHaveTextContent("pinMismatch")
    expect(screen.getByTestId("quick-unlock-draft-step")).toHaveTextContent("pinEnter")
  })

  it("rejects a guessable PIN before it is ever confirmed", async () => {
    const { onEnroll } = renderSettings()
    typePassword()
    fireEvent.click(screen.getByTestId("quick-unlock-add-pin"))

    enterPin("enroll-pin", "123456")
    await flush()

    expect(screen.getByRole("alert")).toHaveTextContent("pin-too-simple")
    expect(screen.getByTestId("quick-unlock-draft-step")).toHaveTextContent("pinEnter")
    expect(onEnroll).not.toHaveBeenCalled()
  })

  it("rejects a guessable pattern", async () => {
    const { onEnroll } = renderSettings()
    typePassword()
    fireEvent.click(screen.getByTestId("quick-unlock-add-pattern"))

    for (const node of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
      fireEvent.click(screen.getByTestId(`enroll-pattern-node-${node}`))
    }
    fireEvent.click(screen.getByTestId("enroll-pattern-submit"))
    await flush()

    expect(screen.getByRole("alert")).toHaveTextContent("pattern-too-simple")
    expect(onEnroll).not.toHaveBeenCalled()
  })

  it("enrolls a pattern drawn twice the same way", async () => {
    const { onEnroll } = renderSettings()
    typePassword()
    fireEvent.click(screen.getByTestId("quick-unlock-add-pattern"))

    for (let round = 0; round < 2; round += 1) {
      for (const node of [0, 3, 4, 5, 8]) {
        fireEvent.click(screen.getByTestId(`enroll-pattern-node-${node}`))
      }
      fireEvent.click(screen.getByTestId("enroll-pattern-submit"))
    }
    await flush()

    expect(onEnroll).toHaveBeenCalledWith(
      expect.objectContaining({ method: "pattern", canonicalSecret: "pattern:0-3-4-5-8" })
    )
  })

  it("carries the passkey credential id through to the enrollment", async () => {
    enrollPasskey.mockResolvedValue({
      ok: true,
      value: { enrollment: { credentialId: "cred-9" }, secret: new Uint8Array(32) },
    })
    const { onEnroll } = renderSettings()
    typePassword()
    fireEvent.click(screen.getByTestId("quick-unlock-add-passkey"))
    fireEvent.click(screen.getByTestId("quick-unlock-enroll-passkey"))
    await flush()

    expect(onEnroll).toHaveBeenCalledWith(
      expect.objectContaining({ method: "passkey", verifier: { credentialId: "cred-9" } })
    )
  })

  it("explains an authenticator that cannot derive a key", async () => {
    // The quiet WebAuthn failure. Enrolling anyway would create a method that
    // can never unlock anything.
    enrollPasskey.mockResolvedValue({ ok: false, reason: "no-prf" })
    const { onEnroll } = renderSettings()
    typePassword()
    fireEvent.click(screen.getByTestId("quick-unlock-add-passkey"))
    fireEvent.click(screen.getByTestId("quick-unlock-enroll-passkey"))
    await flush()

    expect(screen.getByRole("alert")).toHaveTextContent("passkeyFailure.no-prf")
    expect(onEnroll).not.toHaveBeenCalled()
  })

  it("lists an enrolled method as ready", () => {
    renderSettings(account([enrollment({ method: "pin" })]))
    expect(screen.getByTestId("quick-unlock-status-pin")).toHaveTextContent("active")
  })

  it("marks a locked-out method and offers to re-enable it", () => {
    renderSettings(
      account([
        enrollment({ method: "pin", failedAttempts: MAX_QUICK_UNLOCK_ATTEMPTS, lockedOutAt: 1 }),
      ])
    )
    expect(screen.getByTestId("quick-unlock-status-pin")).toHaveTextContent("lockedOut")
    expect(screen.getByTestId("quick-unlock-reenable-pin")).toBeInTheDocument()
  })

  it("requires the password to re-enable, because that is what earns the reset", () => {
    const { onClearLockout } = renderSettings(
      account([
        enrollment({ method: "pin", failedAttempts: MAX_QUICK_UNLOCK_ATTEMPTS, lockedOutAt: 1 }),
      ])
    )
    expect(screen.getByTestId("quick-unlock-reenable-pin")).toBeDisabled()

    typePassword()
    fireEvent.click(screen.getByTestId("quick-unlock-reenable-pin"))
    expect(onClearLockout).toHaveBeenCalledWith("acct-001", "pin", "hunter2hunter2")
  })

  it("offers no re-enable for a method that is working", () => {
    renderSettings(account([enrollment({ method: "pin" })]))
    expect(screen.queryByTestId("quick-unlock-reenable-pin")).not.toBeInTheDocument()
  })

  it("removes a method", () => {
    const { onRemove } = renderSettings(account([enrollment({ method: "pattern" })]))
    fireEvent.click(screen.getByTestId("quick-unlock-remove-pattern"))
    expect(onRemove).toHaveBeenCalledWith("acct-001", "pattern")
  })

  it("offers to replace a method that already exists", () => {
    renderSettings(account([enrollment({ method: "pin" })]))
    typePassword()
    expect(screen.getByTestId("quick-unlock-add-pin")).toHaveTextContent("replace")
  })

  it("abandons a draft on cancel", () => {
    renderSettings()
    typePassword()
    fireEvent.click(screen.getByTestId("quick-unlock-add-pin"))
    expect(screen.getByTestId("quick-unlock-draft")).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("quick-unlock-cancel"))
    expect(screen.queryByTestId("quick-unlock-draft")).not.toBeInTheDocument()
  })

  it("surfaces an enrollment failure instead of appearing to succeed", async () => {
    const onEnroll = jest.fn(async () => {
      throw new Error("Invalid local account password.")
    })
    render(
      <QuickUnlockSettings
        account={account()}
        onEnroll={onEnroll}
        onRemove={jest.fn()}
        onClearLockout={jest.fn()}
      />
    )
    typePassword("wrong")
    fireEvent.click(screen.getByTestId("quick-unlock-add-pin"))
    enterPin("enroll-pin", "428193")
    enterPin("enroll-pin", "428193")
    await flush()

    expect(screen.getByRole("alert")).toHaveTextContent("Invalid local account password.")
    expect(screen.getByTestId("quick-unlock-draft")).toBeInTheDocument()
  })
})
