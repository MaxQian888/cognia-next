"use client"

import { makeDefaultLoader, withPlugin, type ValueOutcome } from "./_shared"

/**
 * `capacitor-native-biometric` wrapper. Used by app-level unlock and by
 * sensitive ops (delete pairing, export backup). Default off — opt-in via
 * Settings → Me → 应用安全.
 *
 * On non-mobile platforms `isAvailable` returns `{ available: false }` so
 * the gate becomes a no-op. Callers should treat that as "skip biometric".
 */

export type BiometryType =
  | "FACE_ID"
  | "TOUCH_ID"
  | "FINGERPRINT"
  | "FACE_AUTHENTICATION"
  | "IRIS_AUTHENTICATION"
  | "MULTIPLE"
  | "NONE"

interface BiometricShape {
  isAvailable(): Promise<{ isAvailable: boolean; biometryType?: BiometryType }>
  verifyIdentity(opts: {
    reason: string
    title?: string
    subtitle?: string
    description?: string
    negativeButtonText?: string
  }): Promise<void>
  setCredentials?(opts: { username: string; password: string; server: string }): Promise<void>
  getCredentials?(opts: { server: string }): Promise<{ username: string; password: string }>
  deleteCredentials?(opts: { server: string }): Promise<void>
}

export type BiometricLoader = () => Promise<BiometricShape>

const defaultLoader: BiometricLoader = makeDefaultLoader<BiometricShape>(
  "capacitor-native-biometric",
  "NativeBiometric"
)

export interface AvailabilityInfo {
  available: boolean
  biometryType?: BiometryType
}

export async function isAvailable(
  loader: BiometricLoader = defaultLoader
): Promise<ValueOutcome<AvailabilityInfo>> {
  const result = await withPlugin(loader, async (b) => {
    const r = await b.isAvailable()
    return {
      kind: "ok" as const,
      value: { available: r.isAvailable, biometryType: r.biometryType },
    }
  })
  if (result && "kind" in result && result.kind === "unsupported") {
    return {
      kind: "ok",
      value: { available: false, biometryType: "NONE" },
    }
  }
  return result
}

export interface VerifyOptions {
  reason: string
  title?: string
  subtitle?: string
  description?: string
  negativeButtonText?: string
  loader?: BiometricLoader
}

export type VerifyOutcome =
  | { kind: "verified" }
  | { kind: "cancelled" }
  | { kind: "lockout" }
  | { kind: "unavailable" }
  | { kind: "error"; message: string }

export async function verify(opts: VerifyOptions): Promise<VerifyOutcome> {
  const { loader = defaultLoader, ...rest } = opts
  let plugin: BiometricShape
  try {
    plugin = await loader()
  } catch {
    return { kind: "unavailable" }
  }
  try {
    const avail = await plugin.isAvailable()
    if (!avail.isAvailable) return { kind: "unavailable" }
    await plugin.verifyIdentity(rest)
    return { kind: "verified" }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/cancel|user.*cancel/i.test(msg)) return { kind: "cancelled" }
    if (/lockout|too many|disabled/i.test(msg)) return { kind: "lockout" }
    return { kind: "error", message: msg }
  }
}
