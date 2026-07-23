"use client"

import { useCallback } from "react"

import { isAvailable, verify, type VerifyOutcome } from "@/lib/capacitor/biometric"

/**
 * Wrap a sensitive action behind a biometric prompt (Wave 1.9).
 *
 * - On platforms without biometrics enrolled (web, desktop, Android phones
 *   with no fingerprint registered), the gate is a no-op and the action
 *   runs immediately.
 * - On enrolled mobile devices, Face ID / Touch ID / fingerprint is
 *   required before the action runs.
 * - Cancellation, lockout, and unexpected errors short-circuit the action
 *   without throwing — the caller gets the `VerifyOutcome` so it can
 *   surface a toast.
 *
 * Usage:
 * ```tsx
 * const guardAndDelete = useBiometricGuard()
 * await guardAndDelete(
 *   { reason: "确认删除配对设备", title: "解除配对" },
 *   async () => deletePairedDevice(deviceId),
 * )
 * ```
 */

export interface BiometricGate {
  reason: string
  title?: string
  subtitle?: string
  description?: string
  /**
   * If true, allow the action through when no biometric is enrolled. If
   * false, the action is blocked unless a real verification succeeds.
   * Defaults to true (graceful degradation).
   */
  fallthroughWhenUnavailable?: boolean
}

export type GuardOutcome<T> =
  { kind: "ok"; value: T } | { kind: "blocked"; reason: VerifyOutcome["kind"] }

export type BiometricGuard = <T>(
  gate: BiometricGate,
  action: () => Promise<T>
) => Promise<GuardOutcome<T>>

export function useBiometricGuard(): BiometricGuard {
  return useCallback(async <T>(gate: BiometricGate, action: () => Promise<T>) => {
    const fallthrough = gate.fallthroughWhenUnavailable ?? true

    const avail = await isAvailable()
    const noEnroll = avail.kind === "ok" && !avail.value.available

    if (noEnroll && fallthrough) {
      const value = await action()
      return { kind: "ok", value }
    }
    if (noEnroll) {
      return { kind: "blocked", reason: "unavailable" }
    }

    const verifyOutcome = await verify({
      reason: gate.reason,
      title: gate.title,
      subtitle: gate.subtitle,
      description: gate.description,
    })

    if (verifyOutcome.kind === "verified") {
      const value = await action()
      return { kind: "ok", value }
    }
    if (verifyOutcome.kind === "unavailable" && fallthrough) {
      const value = await action()
      return { kind: "ok", value }
    }
    return { kind: "blocked", reason: verifyOutcome.kind }
  }, [])
}
