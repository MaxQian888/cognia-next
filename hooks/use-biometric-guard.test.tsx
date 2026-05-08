/**
 * @jest-environment jsdom
 */
import { renderHook } from "@testing-library/react"

import { useBiometricGuard } from "./use-biometric-guard"

jest.mock("@/lib/capacitor/biometric", () => ({
  isAvailable: jest.fn(),
  verify: jest.fn(),
}))

import { isAvailable, verify } from "@/lib/capacitor/biometric"

const mockIsAvailable = isAvailable as jest.MockedFunction<typeof isAvailable>
const mockVerify = verify as jest.MockedFunction<typeof verify>

describe("useBiometricGuard", () => {
  beforeEach(() => {
    mockIsAvailable.mockReset()
    mockVerify.mockReset()
  })

  it("runs action immediately when biometric not enrolled and fallthrough=true", async () => {
    mockIsAvailable.mockResolvedValue({
      kind: "ok",
      value: { available: false, biometryType: "NONE" },
    })
    const action = jest.fn().mockResolvedValue("done")
    const { result } = renderHook(() => useBiometricGuard())
    const out = await result.current({ reason: "x" }, action)
    expect(out).toEqual({ kind: "ok", value: "done" })
    expect(mockVerify).not.toHaveBeenCalled()
    expect(action).toHaveBeenCalled()
  })

  it("blocks when biometric not enrolled and fallthrough=false", async () => {
    mockIsAvailable.mockResolvedValue({
      kind: "ok",
      value: { available: false, biometryType: "NONE" },
    })
    const action = jest.fn().mockResolvedValue("done")
    const { result } = renderHook(() => useBiometricGuard())
    const out = await result.current({ reason: "x", fallthroughWhenUnavailable: false }, action)
    expect(out).toEqual({ kind: "blocked", reason: "unavailable" })
    expect(action).not.toHaveBeenCalled()
  })

  it("runs action after successful verification", async () => {
    mockIsAvailable.mockResolvedValue({
      kind: "ok",
      value: { available: true, biometryType: "FACE_ID" },
    })
    mockVerify.mockResolvedValue({ kind: "verified" })
    const action = jest.fn().mockResolvedValue(42)
    const { result } = renderHook(() => useBiometricGuard())
    const out = await result.current({ reason: "x" }, action)
    expect(out).toEqual({ kind: "ok", value: 42 })
    expect(action).toHaveBeenCalled()
  })

  it("blocks on user cancel", async () => {
    mockIsAvailable.mockResolvedValue({
      kind: "ok",
      value: { available: true, biometryType: "FACE_ID" },
    })
    mockVerify.mockResolvedValue({ kind: "cancelled" })
    const action = jest.fn()
    const { result } = renderHook(() => useBiometricGuard())
    const out = await result.current({ reason: "x" }, action)
    expect(out).toEqual({ kind: "blocked", reason: "cancelled" })
    expect(action).not.toHaveBeenCalled()
  })

  it("blocks on lockout", async () => {
    mockIsAvailable.mockResolvedValue({
      kind: "ok",
      value: { available: true, biometryType: "TOUCH_ID" },
    })
    mockVerify.mockResolvedValue({ kind: "lockout" })
    const { result } = renderHook(() => useBiometricGuard())
    const out = await result.current({ reason: "x" }, async () => "x")
    expect(out).toEqual({ kind: "blocked", reason: "lockout" })
  })

  it("falls through if verify reports unavailable mid-flight", async () => {
    mockIsAvailable.mockResolvedValue({
      kind: "ok",
      value: { available: true, biometryType: "FACE_ID" },
    })
    mockVerify.mockResolvedValue({ kind: "unavailable" })
    const { result } = renderHook(() => useBiometricGuard())
    const out = await result.current({ reason: "x" }, async () => "ok")
    expect(out).toEqual({ kind: "ok", value: "ok" })
  })
})
