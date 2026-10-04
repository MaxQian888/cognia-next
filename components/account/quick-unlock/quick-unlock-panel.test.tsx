/** @jest-environment jsdom */

import { act, fireEvent, render, screen } from "@testing-library/react"

import { QuickUnlockPanel } from "./quick-unlock-panel"
import {
  MAX_QUICK_UNLOCK_ATTEMPTS,
  type QuickUnlockEnrollment,
} from "@/lib/accounts/quick-unlock/types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

const derivePasskeySecret = jest.fn()
let mockMobile = false
const mockReadNative = jest.fn()
jest.mock("@/lib/capacitor/_shared", () => ({
  ...jest.requireActual("@/lib/capacitor/_shared"),
  isMobile: () => mockMobile,
}))
jest.mock("@/lib/accounts/quick-unlock/native-biometric", () => ({
  readNativeBiometricSecret: (...args: unknown[]) => mockReadNative(...args),
}))
jest.mock("@/lib/accounts/quick-unlock/passkey", () => ({
  derivePasskeySecret: (...a: unknown[]) => derivePasskeySecret(...a),
  canonicalizePasskeySecret: (bytes: Uint8Array) => `passkey:${bytes.length}`,
}))

function enrollment(patch: Partial<QuickUnlockEnrollment> = {}): QuickUnlockEnrollment {
  return {
    method: "pin",
    verifier: {},
    createdAt: 0,
    failedAttempts: 0,
    ...patch,
  }
}

function renderPanel(
  enrollments: QuickUnlockEnrollment[],
  onQuickUnlock = jest.fn(async () => ({ ok: true }))
) {
  const onUsePassword = jest.fn()
  render(
    <QuickUnlockPanel
      localAccountId="acct-001"
      enrollments={enrollments}
      onQuickUnlock={onQuickUnlock}
      onUsePassword={onUsePassword}
    />
  )
  return { onQuickUnlock, onUsePassword }
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  mockMobile = false
  mockReadNative.mockReset()
})

describe("QuickUnlockPanel", () => {
  it("uses the native protected read to unlock on mobile", async () => {
    mockMobile = true
    mockReadNative.mockResolvedValue({ ok: true, value: "biometric:protected-secret" })
    const { onQuickUnlock } = renderPanel([
      enrollment({ method: "biometric", verifier: { nativeKeyId: "account-key" } }),
      enrollment({ method: "passkey", verifier: { credentialId: "web-key" } }),
    ])
    expect(screen.queryByTestId("quick-unlock-tab-passkey")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("quick-unlock-biometric"))
    await flush()
    expect(mockReadNative).toHaveBeenCalledWith({
      accountId: "acct-001",
      keyId: "account-key",
      signal: expect.any(AbortSignal),
      prompt: {
        title: "biometricTitle",
        reason: "biometricReason",
        negativeButtonText: "biometricCancel",
      },
    })
    expect(onQuickUnlock).toHaveBeenCalledWith(
      "biometric",
      "biometric:protected-secret",
      mockReadNative.mock.calls[0][0].signal
    )
    expect(derivePasskeySecret).not.toHaveBeenCalled()
  })

  it.each(["cancelled", "failed", "lockout", "unavailable"])(
    "retains password recovery and does not unlock after native %s",
    async (reason) => {
      mockMobile = true
      mockReadNative.mockResolvedValue({ ok: false, reason })
      const { onQuickUnlock, onUsePassword } = renderPanel([
        enrollment({ method: "biometric", verifier: { nativeKeyId: "key" } }),
      ])
      fireEvent.click(screen.getByTestId("quick-unlock-biometric"))
      await flush()
      expect(onQuickUnlock).not.toHaveBeenCalled()
      expect(screen.getByRole("alert")).toHaveTextContent(`biometricFailure.${reason}`)
      fireEvent.click(screen.getByTestId("quick-unlock-use-password"))
      expect(onUsePassword).toHaveBeenCalledTimes(1)
    }
  )

  it("offers password recovery rather than a broken passkey on mobile", () => {
    mockMobile = true
    const { onUsePassword } = renderPanel([
      enrollment({ method: "passkey", verifier: { credentialId: "web-key" } }),
    ])
    expect(screen.queryByTestId("quick-unlock-passkey")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("quick-unlock-use-password"))
    expect(onUsePassword).toHaveBeenCalledTimes(1)
  })

  it("does not expose native biometric controls outside mobile", () => {
    const { onUsePassword } = renderPanel([
      enrollment({ method: "biometric", verifier: { nativeKeyId: "key" } }),
    ])
    expect(screen.queryByTestId("quick-unlock-biometric")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("quick-unlock-use-password"))
    expect(onUsePassword).toHaveBeenCalledTimes(1)
  })

  it("discards a native result after the account changes", async () => {
    mockMobile = true
    let finish!: (value: unknown) => void
    mockReadNative.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    const onQuickUnlock = jest.fn(async () => ({ ok: true }))
    const props = {
      localAccountId: "acct-001",
      enrollments: [enrollment({ method: "biometric", verifier: { nativeKeyId: "key" } })],
      onQuickUnlock,
      onUsePassword: jest.fn(),
    }
    const { rerender } = render(<QuickUnlockPanel {...props} />)
    fireEvent.click(screen.getByTestId("quick-unlock-biometric"))
    rerender(<QuickUnlockPanel {...props} localAccountId="acct-002" />)
    await act(async () => {
      finish({ ok: true, value: "old-account-secret" })
    })
    expect(onQuickUnlock).not.toHaveBeenCalled()
  })

  it("aborts the same signal while backend unlock is pending after native proof", async () => {
    mockMobile = true
    mockReadNative.mockResolvedValue({ ok: true, value: "biometric:protected-secret" })
    let finish!: (value: { ok: boolean }) => void
    const onQuickUnlock = jest.fn(
      () =>
        new Promise<{ ok: boolean }>((resolve) => {
          finish = resolve
        })
    )
    const props = {
      localAccountId: "acct-001",
      enrollments: [enrollment({ method: "biometric", verifier: { nativeKeyId: "key" } })],
      onQuickUnlock,
      onUsePassword: jest.fn(),
    }
    const { rerender } = render(<QuickUnlockPanel {...props} />)
    fireEvent.click(screen.getByTestId("quick-unlock-biometric"))
    await flush()
    const signal = mockReadNative.mock.calls[0][0].signal as AbortSignal
    expect(onQuickUnlock).toHaveBeenCalledWith("biometric", "biometric:protected-secret", signal)
    expect(signal.aborted).toBe(false)
    rerender(<QuickUnlockPanel {...props} localAccountId="acct-002" />)
    expect(signal.aborted).toBe(true)
    await act(async () => {
      finish({ ok: false })
    })
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it.each(["unmount", "replace-key", "disabled"])(
    "discards native material after %s",
    async (change) => {
      mockMobile = true
      let finish!: (value: unknown) => void
      let signal!: AbortSignal
      mockReadNative.mockImplementation((args) => {
        signal = args.signal
        return new Promise((resolve) => {
          finish = resolve
        })
      })
      const onQuickUnlock = jest.fn(async () => ({ ok: true }))
      const props = {
        localAccountId: "acct-001",
        enrollments: [enrollment({ method: "biometric", verifier: { nativeKeyId: "old-key" } })],
        onQuickUnlock,
        onUsePassword: jest.fn(),
      }
      const { unmount, rerender } = render(<QuickUnlockPanel {...props} />)
      fireEvent.click(screen.getByTestId("quick-unlock-biometric"))
      if (change === "unmount") unmount()
      else if (change === "disabled") rerender(<QuickUnlockPanel {...props} disabled />)
      else
        rerender(
          <QuickUnlockPanel
            {...props}
            enrollments={[
              enrollment({ method: "biometric", verifier: { nativeKeyId: "replacement-key" } }),
            ]}
          />
        )
      expect(signal.aborted).toBe(true)
      await act(async () => {
        finish({ ok: true, value: "old-secret" })
      })
      expect(onQuickUnlock).not.toHaveBeenCalled()
      if (change !== "unmount")
        expect(screen.getByTestId("quick-unlock-use-password")).toBeEnabled()
    }
  )

  it("renders nothing when no method is enrolled", () => {
    const { container } = render(
      <QuickUnlockPanel
        localAccountId="acct-001"
        enrollments={[]}
        onQuickUnlock={jest.fn()}
        onUsePassword={jest.fn()}
      />
    )
    expect(container.innerHTML).toBe("")
  })

  it("submits a canonicalised PIN", async () => {
    const { onQuickUnlock } = renderPanel([enrollment({ method: "pin" })])
    for (const digit of "428193") fireEvent.click(screen.getByTestId(`pin-key-${digit}`))
    fireEvent.click(screen.getByTestId("pin-submit"))
    await flush()
    expect(onQuickUnlock).toHaveBeenCalledWith("pin", "pin:428193")
  })

  it("submits a canonicalised pattern", async () => {
    const { onQuickUnlock } = renderPanel([enrollment({ method: "pattern" })])
    for (const node of [0, 3, 4, 5, 8]) {
      fireEvent.click(screen.getByTestId(`pattern-node-${node}`))
    }
    fireEvent.click(screen.getByTestId("pattern-submit"))
    await flush()
    expect(onQuickUnlock).toHaveBeenCalledWith("pattern", "pattern:0-3-4-5-8")
  })

  it("hides the method tabs when only one is enrolled", () => {
    renderPanel([enrollment({ method: "pin" })])
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument()
  })

  it("switches between enrolled methods", () => {
    renderPanel([enrollment({ method: "pin" }), enrollment({ method: "pattern" })])
    expect(screen.getByTestId("pin-pad")).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("quick-unlock-tab-pattern"))
    expect(screen.getByTestId("pattern-grid")).toBeInTheDocument()
    expect(screen.queryByTestId("pin-pad")).not.toBeInTheDocument()
  })

  it("never lands on a locked-out method by default", () => {
    // Opening onto a surface that cannot work is a dead end.
    renderPanel([
      enrollment({ method: "pin", failedAttempts: MAX_QUICK_UNLOCK_ATTEMPTS, lockedOutAt: 1 }),
      enrollment({ method: "pattern" }),
    ])
    expect(screen.getByTestId("pattern-grid")).toBeInTheDocument()
  })

  it("shows a locked-out method rather than hiding it", () => {
    // Hiding it would collapse "never enrolled" and "disabled after too many
    // attempts" into the same blank space.
    renderPanel([
      enrollment({ method: "pin", failedAttempts: MAX_QUICK_UNLOCK_ATTEMPTS, lockedOutAt: 1 }),
    ])
    expect(screen.getByTestId("quick-unlock-locked-out")).toBeInTheDocument()
    expect(screen.getByTestId("pin-pad")).toBeInTheDocument()
    expect(screen.getByTestId("pin-key-4")).toBeDisabled()
  })

  it("surfaces a wrong secret without leaving the panel", async () => {
    const onQuickUnlock = jest.fn(async () => ({ ok: false, reason: "wrong-secret" as const }))
    renderPanel([enrollment({ method: "pin" })], onQuickUnlock)

    for (const digit of "000000") fireEvent.click(screen.getByTestId(`pin-key-${digit}`))
    fireEvent.click(screen.getByTestId("pin-submit"))
    await flush()

    expect(screen.getByRole("alert")).toHaveTextContent("failure.wrong-secret")
  })

  it("reports a thrown error rather than leaving the panel stuck", async () => {
    const onQuickUnlock = jest.fn(async () => {
      throw new Error("boom")
    })
    renderPanel([enrollment({ method: "pin" })], onQuickUnlock)

    for (const digit of "428193") fireEvent.click(screen.getByTestId(`pin-key-${digit}`))
    fireEvent.click(screen.getByTestId("pin-submit"))
    await flush()

    expect(screen.getByRole("alert")).toHaveTextContent("failure.failed")
    expect(screen.getByTestId("pin-key-4")).not.toBeDisabled()
  })

  it("warns only as the attempts run low", async () => {
    renderPanel([enrollment({ method: "pin", failedAttempts: 0 })])
    expect(screen.queryByText(/attemptsLeft/)).not.toBeInTheDocument()

    render(
      <QuickUnlockPanel
        localAccountId="acct-001"
        enrollments={[enrollment({ method: "pin", failedAttempts: MAX_QUICK_UNLOCK_ATTEMPTS - 2 })]}
        onQuickUnlock={jest.fn()}
        onUsePassword={jest.fn()}
      />
    )
    expect(screen.getAllByText(/attemptsLeft/).length).toBeGreaterThan(0)
  })

  it("always offers the password, because it is the only factor that stands alone", () => {
    const { onUsePassword } = renderPanel([enrollment({ method: "pin" })])
    fireEvent.click(screen.getByTestId("quick-unlock-use-password"))
    expect(onUsePassword).toHaveBeenCalled()
  })

  it("derives a passkey secret and submits it", async () => {
    derivePasskeySecret.mockResolvedValue({ ok: true, value: new Uint8Array(32) })
    const { onQuickUnlock } = renderPanel([
      enrollment({ method: "passkey", verifier: { credentialId: "cred-1" } }),
    ])

    fireEvent.click(screen.getByTestId("quick-unlock-passkey"))
    await flush()

    expect(derivePasskeySecret).toHaveBeenCalledWith({
      localAccountId: "acct-001",
      credentialId: "cred-1",
    })
    expect(onQuickUnlock).toHaveBeenCalledWith("passkey", "passkey:32")
  })

  it("reports a cancelled passkey prompt as cancelled, not as a bad credential", async () => {
    // Telling a user their passkey is broken when they simply changed their
    // mind sends them off replacing a working credential.
    derivePasskeySecret.mockResolvedValue({ ok: false, reason: "cancelled" })
    const { onQuickUnlock } = renderPanel([
      enrollment({ method: "passkey", verifier: { credentialId: "cred-1" } }),
    ])

    fireEvent.click(screen.getByTestId("quick-unlock-passkey"))
    await flush()

    expect(screen.getByRole("alert")).toHaveTextContent("passkeyFailure.cancelled")
    expect(onQuickUnlock).not.toHaveBeenCalled()
  })

  it("reports an enrollment with no credential id", async () => {
    renderPanel([enrollment({ method: "passkey", verifier: {} })])
    fireEvent.click(screen.getByTestId("quick-unlock-passkey"))
    await flush()
    expect(screen.getByRole("alert")).toHaveTextContent("failure.not-enrolled")
    expect(derivePasskeySecret).not.toHaveBeenCalled()
  })

  it("clears a previous error when the method changes", async () => {
    const onQuickUnlock = jest.fn(async () => ({ ok: false, reason: "wrong-secret" as const }))
    renderPanel([enrollment({ method: "pin" }), enrollment({ method: "pattern" })], onQuickUnlock)

    for (const digit of "000000") fireEvent.click(screen.getByTestId(`pin-key-${digit}`))
    fireEvent.click(screen.getByTestId("pin-submit"))
    await flush()
    expect(screen.getByRole("alert")).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("quick-unlock-tab-pattern"))
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })
})
