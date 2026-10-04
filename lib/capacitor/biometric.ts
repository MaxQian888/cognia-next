"use client"

import { detectNativePlatform, makeDefaultLoader, type ValueOutcome } from "./_shared"

/**
 * `@capgo/capacitor-native-biometric` wrapper (Capacitor 8 maintained fork of
 * the unmaintained `capacitor-native-biometric`). Used by app-level unlock and by
 * sensitive ops (delete pairing, export backup). Default off — opt-in via
 * Settings → Me → 应用安全.
 *
 * Absence on web/desktop is distinct from a failing mobile native bridge.
 * Only a confirmed unsupported platform or no enrollment may bypass an
 * optional gate; lockout and runtime failures must never do so.
 */

export type BiometryType =
  | "FACE_ID"
  | "TOUCH_ID"
  | "FINGERPRINT"
  | "FACE_AUTHENTICATION"
  | "IRIS_AUTHENTICATION"
  | "MULTIPLE"
  | "DEVICE_CREDENTIAL"
  | "NONE"

/**
 * The native plugin returns `biometryType` as a NUMERIC enum
 * (`NONE=0 … DEVICE_CREDENTIAL=7`), not the string union our public API
 * exposes. Translate here — the single point where plugin values enter.
 */
const BIOMETRY_TYPE_BY_CODE: Record<number, BiometryType> = {
  0: "NONE",
  1: "TOUCH_ID",
  2: "FACE_ID",
  3: "FINGERPRINT",
  4: "FACE_AUTHENTICATION",
  5: "IRIS_AUTHENTICATION",
  6: "MULTIPLE",
  7: "DEVICE_CREDENTIAL",
}

function toBiometryType(raw: BiometryType | number | undefined): BiometryType | undefined {
  if (raw === undefined) return undefined
  if (typeof raw === "number") return BIOMETRY_TYPE_BY_CODE[raw] ?? "NONE"
  return raw
}

interface BiometricShape {
  isAvailable(): Promise<{
    isAvailable: boolean
    biometryType?: BiometryType | number
    errorCode?: number
    authenticationStrength?: 0 | 1 | 2
    strongBiometryIsAvailable?: boolean
    deviceIsSecure?: boolean
  }>
  verifyIdentity(opts: {
    reason: string
    title?: string
    subtitle?: string
    description?: string
    negativeButtonText?: string
    maxAttempts?: number
  }): Promise<void>
}

export type BiometricLoader = () => Promise<BiometricShape>

const defaultLoader: BiometricLoader = makeDefaultLoader<BiometricShape>(
  "@capgo/capacitor-native-biometric",
  "NativeBiometric"
)

export interface AvailabilityInfo {
  available: boolean
  biometryType?: BiometryType
  reason?: "unsupported" | "not_enrolled" | "lockout" | "temporarily_unavailable" | "error"
  errorCode?: number
  authenticationStrength?: 0 | 1 | 2
  strongBiometryIsAvailable?: boolean
  deviceIsSecure?: boolean
}

export async function isAvailable(
  loader: BiometricLoader = defaultLoader
): Promise<ValueOutcome<AvailabilityInfo>> {
  let plugin: BiometricShape
  try {
    plugin = await loader()
  } catch (error) {
    if (detectNativePlatform() !== "mobile") {
      return {
        kind: "ok",
        value: { available: false, biometryType: "NONE", reason: "unsupported" },
      }
    }
    return { kind: "error", message: errorMessage(error) }
  }
  try {
    const r = await plugin.isAvailable()
    if (!r || typeof r.isAvailable !== "boolean") {
      return { kind: "error", message: "Invalid biometric availability result" }
    }
    const reason: AvailabilityInfo["reason"] = r.isAvailable
      ? undefined
      : r.errorCode === 3
        ? "not_enrolled"
        : r.errorCode === 2 || r.errorCode === 4
          ? "lockout"
          : r.errorCode === 1
            ? "temporarily_unavailable"
            : "error"
    return {
      kind: "ok",
      value: {
        available: r.isAvailable,
        biometryType: toBiometryType(r.biometryType),
        ...(reason ? { reason } : {}),
        ...(r.errorCode !== undefined ? { errorCode: r.errorCode } : {}),
        ...(r.authenticationStrength !== undefined
          ? { authenticationStrength: r.authenticationStrength }
          : {}),
        ...(r.strongBiometryIsAvailable !== undefined
          ? { strongBiometryIsAvailable: r.strongBiometryIsAvailable }
          : {}),
        ...(r.deviceIsSecure !== undefined ? { deviceIsSecure: r.deviceIsSecure } : {}),
      },
    }
  } catch (error) {
    return { kind: "error", message: errorMessage(error) }
  }
}

export interface VerifyOptions {
  reason: string
  title?: string
  subtitle?: string
  description?: string
  negativeButtonText?: string
  /** Android limits each prompt to one through five attempts. Defaults to five. */
  maxAttempts?: number
  loader?: BiometricLoader
}

export type VerifyOutcome =
  | { kind: "verified" }
  | { kind: "cancelled" }
  | { kind: "lockout" }
  | { kind: "unavailable"; reason?: "unsupported" | "not_enrolled" }
  | { kind: "error"; message: string }

function errorMessage(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message
  }
  return String(error)
}

/** Normalize the shared native error contract for prompts and secure-storage authentication. */
export function normalizeBiometricError(
  error: unknown
): Exclude<VerifyOutcome, { kind: "verified" }> {
  const message = errorMessage(error)
  const rawCode = (error as { code?: string | number } | null)?.code
  const code = typeof rawCode === "string" && rawCode.trim() !== "" ? Number(rawCode) : rawCode
  if (typeof code === "number" && Number.isFinite(code)) {
    if (code === 11 || code === 15 || code === 16 || code === 17) return { kind: "cancelled" }
    if (code === 2 || code === 4) return { kind: "lockout" }
    if (code === 3) return { kind: "unavailable", reason: "not_enrolled" }
    return { kind: "error", message }
  }
  if (/cancel|user.*cancel/i.test(message)) return { kind: "cancelled" }
  if (/lockout|too many/i.test(message)) return { kind: "lockout" }
  return { kind: "error", message }
}

let verificationPending = false

/** Share one prompt slot across verification and biometric-protected vault operations. */
export async function withBiometricPromptLock<T>(action: () => Promise<T>): Promise<T> {
  if (verificationPending) throw new Error("Biometric verification already in progress")
  verificationPending = true
  try {
    return await action()
  } finally {
    verificationPending = false
  }
}

export async function verify(opts: VerifyOptions): Promise<VerifyOutcome> {
  try {
    return await withBiometricPromptLock(() => verifyUnlocked(opts))
  } catch (error) {
    return normalizeBiometricError(error)
  }
}

async function verifyUnlocked(opts: VerifyOptions): Promise<VerifyOutcome> {
  const { loader = defaultLoader, maxAttempts = 5, ...rest } = opts
  try {
    // Reuse this instance for the availability check and prompt.
    let plugin: BiometricShape | undefined
    const availability = await isAvailable(async () => {
      plugin = await loader()
      return plugin
    })
    if (availability.kind !== "ok") {
      return {
        kind: "error",
        message:
          availability.kind === "error" ? availability.message : "Biometric bridge unavailable",
      }
    }
    if (!availability.value.available) {
      const reason = availability.value.reason
      if (reason === "unsupported" || reason === "not_enrolled")
        return { kind: "unavailable", reason }
      if (reason === "lockout") return { kind: "lockout" }
      return { kind: "error", message: "Biometric authentication is currently unavailable" }
    }
    if (!plugin) return { kind: "error", message: "Biometric bridge unavailable" }
    await plugin.verifyIdentity({
      ...rest,
      maxAttempts: Number.isFinite(maxAttempts)
        ? Math.max(1, Math.min(5, Math.floor(maxAttempts)))
        : 5,
    })
    return { kind: "verified" }
  } catch (error) {
    const outcome = normalizeBiometricError(error)
    // A lost enrollment after preflight must not turn this attempted
    // authentication into permission to skip a protected operation.
    return outcome.kind === "unavailable"
      ? { kind: "error", message: errorMessage(error) }
      : outcome
  }
}
