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

/**
 * Why the guard refused to run the action. A machine code, not copy: show it
 * to a person through `useBiometricBlockReason()`, never interpolated raw.
 */
export type BiometricBlockReason = Exclude<VerifyOutcome["kind"], "verified">

export type GuardOutcome<T> =
  { kind: "ok"; value: T } | { kind: "blocked"; reason: BiometricBlockReason }

export type BiometricGuard = <T>(
  gate: BiometricGate,
  action: () => Promise<T>
) => Promise<GuardOutcome<T>>

export function useBiometricGuard(): BiometricGuard {
  return useCallback(async <T>(gate: BiometricGate, action: () => Promise<T>) => {
    const fallthrough = gate.fallthroughWhenUnavailable ?? true

    const avail = await isAvailable()
    if (avail.kind !== "ok") return { kind: "blocked", reason: "error" }
    if (!avail.value.available) {
      const reason = avail.value.reason
      const canSkip = reason === "unsupported" || reason === "not_enrolled"
      if (canSkip && fallthrough) return { kind: "ok", value: await action() }
      return {
        kind: "blocked",
        reason: reason === "lockout" ? "lockout" : canSkip ? "unavailable" : "error",
      }
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
    // Availability changed after a successful preflight. Never silently
    // weaken the gate mid-operation, even if enrollment was just removed.
    return { kind: "blocked", reason: verifyOutcome.kind }
  }, [])
}
