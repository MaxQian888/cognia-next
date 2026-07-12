"use client"

import { makeDefaultLoader, withPlugin, type ValueOutcome } from "./_shared"

/**
 * `@capgo/capacitor-native-biometric` wrapper (Capacitor 8 maintained fork of
 * the unmaintained `capacitor-native-biometric`). Used by app-level unlock and by
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
  isAvailable(): Promise<{ isAvailable: boolean; biometryType?: BiometryType | number }>
  verifyIdentity(opts: {
    reason: string
    title?: string
    subtitle?: string
    description?: string
    negativeButtonText?: string
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
}

export async function isAvailable(
  loader: BiometricLoader = defaultLoader
): Promise<ValueOutcome<AvailabilityInfo>> {
  const result = await withPlugin(loader, async (b) => {
    const r = await b.isAvailable()
    return {
      kind: "ok" as const,
      value: { available: r.isAvailable, biometryType: toBiometryType(r.biometryType) },
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
    // Prefer the plugin's numeric error code — messages vary by platform and
    // locale. (15 app cancel / 16 user cancel / 17 user fallback; 2 lockout /
    // 4 temporary lockout; 1 unavailable / 3 not enrolled.)
    const rawCode = (err as { code?: string | number } | null)?.code
    const code = typeof rawCode === "string" ? Number.parseInt(rawCode, 10) : rawCode
    if (typeof code === "number" && Number.isFinite(code)) {
      if (code === 15 || code === 16 || code === 17) return { kind: "cancelled" }
      if (code === 2 || code === 4) return { kind: "lockout" }
      if (code === 1 || code === 3) return { kind: "unavailable" }
    }
    if (/cancel|user.*cancel/i.test(msg)) return { kind: "cancelled" }
    if (/lockout|too many|disabled/i.test(msg)) return { kind: "lockout" }
    return { kind: "error", message: msg }
  }
}
