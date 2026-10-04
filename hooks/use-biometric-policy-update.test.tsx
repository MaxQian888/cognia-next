/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react"
import { DEFAULT_BIOMETRIC_GUARD } from "@cognia/agent-config-types"
import { useBiometricPolicyUpdate } from "./use-biometric-policy-update"

const mockGuard = jest.fn()
const mockIsMobile = jest.fn()
const mockError = jest.fn()
let mockPolicy = { ...DEFAULT_BIOMETRIC_GUARD }
let mockAccountId = "account-a"
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: {
    getState: () => ({ activeAccountId: mockAccountId, unlockedAccountId: mockAccountId }),
  },
}))
jest.mock("@/lib/runtime/runtime-target-context", () => ({
  getActiveRuntimeTargetContext: () => null,
}))
jest.mock("@/hooks/use-biometric-guard", () => ({ useBiometricGuard: () => mockGuard }))
jest.mock("@/lib/capacitor/_shared", () => ({ isMobile: () => mockIsMobile() }))
jest.mock("@/stores/settings", () => ({
  useSettingsStore: { getState: () => ({ settings: { biometricRequiredFor: mockPolicy } }) },
}))
jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("sonner", () => ({ toast: { error: (...args: unknown[]) => mockError(...args) } }))

beforeEach(() => {
  mockGuard.mockReset()
  mockGuard.mockImplementation(async (_gate, action) => ({ kind: "ok", value: await action() }))
  mockIsMobile.mockReturnValue(true)
  mockError.mockClear()
  mockPolicy = { ...DEFAULT_BIOMETRIC_GUARD }
  mockAccountId = "account-a"
})

it.each(["cancelled", "unavailable", "lockout", "error"])(
  "does not disable an enabled native gate after %s",
  async (reason) => {
    mockGuard.mockResolvedValue({ kind: "blocked", reason })
    const save = jest.fn()
    const { result } = renderHook(() => useBiometricPolicyUpdate(save))
    await act(async () => {
      await result.current.updatePolicy({ signOut: false })
    })
    expect(mockGuard.mock.calls[0][0]).toMatchObject({ fallthroughWhenUnavailable: false })
    expect(save).not.toHaveBeenCalled()
    expect(result.current.pending).toBe(false)
    expect(mockError).toHaveBeenCalledTimes(reason === "cancelled" ? 0 : 1)
  }
)

it("requires verification before disabling and merges unrelated changes made during the prompt", async () => {
  let approve!: () => Promise<unknown>
  mockGuard.mockImplementation(
    (_gate, action) =>
      new Promise((resolve) => {
        approve = async () => resolve({ kind: "ok", value: await action() })
      })
  )
  const save = jest.fn().mockResolvedValue(undefined)
  const { result } = renderHook(() => useBiometricPolicyUpdate(save))
  let operation!: Promise<void>
  act(() => {
    operation = result.current.updatePolicy({ signOut: false })
  })
  expect(result.current.pending).toBe(true)
  expect(save).not.toHaveBeenCalled()
  mockPolicy = { ...mockPolicy, exportBackup: true }
  await act(async () => {
    await approve()
    await operation
  })
  expect(save).toHaveBeenCalledWith({ biometricRequiredFor: { ...mockPolicy, signOut: false } })
  expect(result.current.pending).toBe(false)
})

it("enables protection without a prompt", async () => {
  const save = jest.fn().mockResolvedValue(undefined)
  const { result } = renderHook(() => useBiometricPolicyUpdate(save))
  await act(async () => {
    await result.current.updatePolicy({ revealSecrets: true })
  })
  expect(mockGuard).not.toHaveBeenCalled()
  expect(save).toHaveBeenCalledWith({
    biometricRequiredFor: { ...mockPolicy, revealSecrets: true },
  })
})

it("keeps policy settings editable on hosts without native biometric support", async () => {
  mockIsMobile.mockReturnValue(false)
  const save = jest.fn().mockResolvedValue(undefined)
  const { result } = renderHook(() => useBiometricPolicyUpdate(save))
  await act(async () => {
    await result.current.updatePolicy({ signOut: false })
  })
  expect(mockGuard).not.toHaveBeenCalled()
  expect(save).toHaveBeenCalledTimes(1)
})

it("does not save a late verification after the editor unmounts", async () => {
  let approve!: () => Promise<unknown>
  mockGuard.mockImplementation(
    (_gate, action) =>
      new Promise((resolve) => {
        approve = async () => resolve({ kind: "ok", value: await action() })
      })
  )
  const save = jest.fn()
  const { result, unmount } = renderHook(() => useBiometricPolicyUpdate(save))
  let operation!: Promise<void>
  act(() => {
    operation = result.current.updatePolicy({ signOut: false })
  })
  unmount()
  await approve()
  await operation
  expect(save).not.toHaveBeenCalled()
})

it("does not apply confirmation to an account selected during the prompt", async () => {
  mockGuard.mockImplementation(async (_gate, action) => {
    mockAccountId = "account-b"
    return { kind: "ok", value: await action() }
  })
  const save = jest.fn()
  const { result } = renderHook(() => useBiometricPolicyUpdate(save))
  await act(async () => {
    await result.current.updatePolicy({ signOut: false })
  })
  expect(save).not.toHaveBeenCalled()
  expect(mockError).toHaveBeenCalledWith("policyChangeContextChanged")
})
