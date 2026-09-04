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
})

describe("QuickUnlockPanel", () => {
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
