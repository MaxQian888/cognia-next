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
})

describe("QuickUnlockSettings", () => {
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
