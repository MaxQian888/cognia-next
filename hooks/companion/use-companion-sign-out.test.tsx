/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react"

import { DEFAULT_BIOMETRIC_GUARD } from "@cognia/agent-config-types"

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const routerMock = {
  replace: jest.fn(),
}
jest.mock("next/navigation", () => ({
  useRouter: () => routerMock,
}))

import type { VerifyOutcome } from "@/lib/capacitor/biometric"

const verifyMock = jest.fn(async (_opts: unknown): Promise<VerifyOutcome> => ({ kind: "verified" }))
jest.mock("@/lib/capacitor/biometric", () => ({
  verify: (opts: unknown) => verifyMock(opts),
}))

// The hook clears the pairing through `clearCompanionConfig()` (transport
// layer) so the in-memory config cache is wiped alongside SecureStorage —
// mock that, not the raw storage backend.
const clearMock: jest.Mock<Promise<void>, []> = jest.fn(async () => undefined)
jest.mock("@/lib/tauri/transport-companion", () => ({
  // Lazy wrapper: the factory is hoisted above `clearMock`, so reference it
  // through a closure that resolves at call time rather than at module init.
  clearCompanionConfig: () => clearMock(),
}))

const anthropicSignOutMock: jest.Mock<Promise<void>, []> = jest.fn(async () => undefined)
jest.mock("@/lib/subscription/anthropic/hooks", () => ({
  useActiveAnthropicCredential: () => ({
    activeAccountId: null,
    credential: null,
    loading: false,
    reload: jest.fn(async () => undefined),
    refresh: jest.fn(async () => null),
    signOut: anthropicSignOutMock,
  }),
}))

const settingsRef: {
  current: { biometricRequiredFor?: typeof DEFAULT_BIOMETRIC_GUARD } | undefined
} = { current: { biometricRequiredFor: { ...DEFAULT_BIOMETRIC_GUARD } } }

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: { settings: typeof settingsRef.current }) => unknown) =>
    selector({ settings: settingsRef.current }),
}))

import { useCompanionSignOut } from "./use-companion-sign-out"

beforeEach(() => {
  routerMock.replace.mockClear()
  verifyMock.mockClear()
  verifyMock.mockResolvedValue({ kind: "verified" })
  clearMock.mockClear()
  anthropicSignOutMock.mockClear()
  settingsRef.current = { biometricRequiredFor: { ...DEFAULT_BIOMETRIC_GUARD } }
})

const PROMPT = { reason: "Confirm to sign out", title: "Sign out" }

describe("useCompanionSignOut", () => {
  it("verifies biometric, clears anthropic + pairing, and redirects on success", async () => {
    const { result } = renderHook(() => useCompanionSignOut({ prompt: PROMPT }))

    let outcome: Awaited<ReturnType<typeof result.current.signOut>> | null = null
    await act(async () => {
      outcome = await result.current.signOut()
    })

    expect(outcome).toEqual({ kind: "ok" })
    expect(verifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "Confirm to sign out" })
    )
    expect(anthropicSignOutMock).toHaveBeenCalledTimes(1)
    expect(clearMock).toHaveBeenCalledTimes(1)
    expect(routerMock.replace).toHaveBeenCalledWith("/pair")
  })

  it("respects a custom redirectTo", async () => {
    const { result } = renderHook(() =>
      useCompanionSignOut({ prompt: PROMPT, redirectTo: "/welcome" })
    )
    await act(async () => {
      await result.current.signOut()
    })
    expect(routerMock.replace).toHaveBeenCalledWith("/welcome")
  })

  it("returns 'blocked: cancelled' when biometric is cancelled — no clear, no redirect", async () => {
    verifyMock.mockResolvedValueOnce({ kind: "cancelled" })
    const { result } = renderHook(() => useCompanionSignOut({ prompt: PROMPT }))
    let outcome: Awaited<ReturnType<typeof result.current.signOut>> | null = null
    await act(async () => {
      outcome = await result.current.signOut()
    })
    expect(outcome).toEqual({ kind: "blocked", reason: "cancelled" })
    expect(anthropicSignOutMock).not.toHaveBeenCalled()
    expect(clearMock).not.toHaveBeenCalled()
    expect(routerMock.replace).not.toHaveBeenCalled()
  })

  it("returns 'blocked: lockout' when biometric reports lockout", async () => {
    verifyMock.mockResolvedValueOnce({ kind: "lockout" })
    const { result } = renderHook(() => useCompanionSignOut({ prompt: PROMPT }))
    let outcome: Awaited<ReturnType<typeof result.current.signOut>> | null = null
    await act(async () => {
      outcome = await result.current.signOut()
    })
    expect(outcome).toEqual({ kind: "blocked", reason: "lockout" })
    expect(clearMock).not.toHaveBeenCalled()
  })

  it("returns 'blocked: error' carrying the message on verify failure", async () => {
    verifyMock.mockResolvedValueOnce({ kind: "error", message: "sensor offline" })
    const { result } = renderHook(() => useCompanionSignOut({ prompt: PROMPT }))
    let outcome: Awaited<ReturnType<typeof result.current.signOut>> | null = null
    await act(async () => {
      outcome = await result.current.signOut()
    })
    expect(outcome).toEqual({
      kind: "blocked",
      reason: "error",
      message: "sensor offline",
    })
  })

  it("falls through 'unavailable' as a successful clear (devices without biometric)", async () => {
    verifyMock.mockResolvedValueOnce({ kind: "unavailable" })
    const { result } = renderHook(() => useCompanionSignOut({ prompt: PROMPT }))
    await act(async () => {
      await result.current.signOut()
    })
    expect(clearMock).toHaveBeenCalledTimes(1)
    expect(routerMock.replace).toHaveBeenCalledWith("/pair")
  })

  it("skips the biometric gate when policy.signOut is false", async () => {
    settingsRef.current = {
      biometricRequiredFor: { ...DEFAULT_BIOMETRIC_GUARD, signOut: false },
    }
    const { result } = renderHook(() => useCompanionSignOut({ prompt: PROMPT }))
    await act(async () => {
      await result.current.signOut()
    })
    expect(verifyMock).not.toHaveBeenCalled()
    expect(clearMock).toHaveBeenCalledTimes(1)
  })

  it("swallows anthropicSignOut failures so the pair clear still runs", async () => {
    anthropicSignOutMock.mockRejectedValueOnce(new Error("vault offline"))
    const { result } = renderHook(() => useCompanionSignOut({ prompt: PROMPT }))
    let outcome: Awaited<ReturnType<typeof result.current.signOut>> | null = null
    await act(async () => {
      outcome = await result.current.signOut()
    })
    expect(outcome).toEqual({ kind: "ok" })
    expect(clearMock).toHaveBeenCalledTimes(1)
    expect(routerMock.replace).toHaveBeenCalledWith("/pair")
  })

  it("toggles pending while the call is in flight", async () => {
    let resolveClear: (() => void) | null = null
    clearMock.mockImplementationOnce(
      () =>
        new Promise<void>((res) => {
          resolveClear = () => res()
        })
    )

    const { result } = renderHook(() => useCompanionSignOut({ prompt: PROMPT }))
    expect(result.current.pending).toBe(false)
    let promise: Promise<unknown>
    act(() => {
      promise = result.current.signOut()
    })
    await waitFor(() => expect(result.current.pending).toBe(true))
    act(() => {
      resolveClear?.()
    })
    await act(async () => {
      await promise!
    })
    expect(result.current.pending).toBe(false)
  })
})
