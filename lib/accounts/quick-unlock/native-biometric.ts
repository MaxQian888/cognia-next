"use client"

import { isMobile, makeDefaultLoader } from "@/lib/capacitor/_shared"
import { normalizeBiometricError, withBiometricPromptLock } from "@/lib/capacitor/biometric"

/** Account-scoped key material, protected by the enrolled biometric set, never a saved password. */
export interface NativeBiometricPrompt {
  title: string
  reason: string
  negativeButtonText: string
}

interface ProtectedBiometricStorage {
  isAvailable(): Promise<{ isAvailable: boolean; strongBiometryIsAvailable: boolean }>
  setData(options: {
    key: string
    value: string
    accessControl: number
    authValidityDuration: number
    title: string
    negativeButtonText: string
  }): Promise<void>
  getSecureData(
    options: NativeBiometricPrompt & { key: string; fallbackTitle: string }
  ): Promise<{ value: string }>
  deleteData(options: { key: string }): Promise<void>
}

type Loader = () => Promise<ProtectedBiometricStorage>
const defaultLoader = makeDefaultLoader<ProtectedBiometricStorage>(
  "@capgo/capacitor-native-biometric",
  "NativeBiometric"
)
export type NativeBiometricFailure = "unavailable" | "cancelled" | "lockout" | "failed"
type Result<T> = { ok: true; value: T } | { ok: false; reason: NativeBiometricFailure }

function keyPrefix(accountId: string): string {
  return `cognia.account-biometric.v1:${encodeURIComponent(accountId)}:`
}

function ownsKey(accountId: string, keyId: string): boolean {
  return (
    keyId.startsWith(keyPrefix(accountId)) &&
    /^[a-f0-9-]{36}$/.test(keyId.slice(keyPrefix(accountId).length))
  )
}

function failure(error: unknown): { ok: false; reason: NativeBiometricFailure } {
  if (error && typeof error === "object") {
    const { code, message } = error as { code?: unknown; message?: unknown }
    // CurrentSet invalidation deletes protected material. Repeating the prompt
    // cannot recover it; direct the user to password unlock and re-enrollment.
    if (
      String(code) === "21" ||
      (String(code) === "0" && message === "Biometric enrollment changed")
    ) {
      return { ok: false, reason: "unavailable" }
    }
  }
  const outcome = normalizeBiometricError(error)
  return { ok: false, reason: outcome.kind === "error" ? "failed" : outcome.kind }
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw { code: 11, message: "Biometric operation cancelled" }
}

/** Store a fresh candidate, prove authenticated access, then persist its vault wrap/reference. */
export async function enrollNativeBiometric(args: {
  accountId: string
  prompt: NativeBiometricPrompt
  commit: (canonicalSecret: string, keyId: string) => Promise<void>
  loader?: Loader
  signal?: AbortSignal
}): Promise<{ ok: true } | { ok: false; reason: NativeBiometricFailure }> {
  if (!isMobile()) return { ok: false, reason: "unavailable" }
  try {
    return await withBiometricPromptLock(async () => {
      checkAbort(args.signal)
      const native = await (args.loader ?? defaultLoader)()
      const availability = await native.isAvailable()
      checkAbort(args.signal)
      // Android's per-operation Keystore authentication requires Class 3.
      if (!availability.isAvailable || !availability.strongBiometryIsAvailable)
        return { ok: false as const, reason: "unavailable" as const }
      const keyId = `${keyPrefix(args.accountId)}${crypto.randomUUID()}`
      const bytes = crypto.getRandomValues(new Uint8Array(32))
      const secret = `biometric:${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`
      bytes.fill(0)
      try {
        await native.setData({
          key: keyId,
          value: secret,
          accessControl: 1,
          authValidityDuration: 0,
          title: args.prompt.title,
          negativeButtonText: args.prompt.negativeButtonText,
        })
        checkAbort(args.signal)
        const read = await native.getSecureData({ key: keyId, ...args.prompt, fallbackTitle: "" })
        checkAbort(args.signal)
        if (read.value !== secret)
          throw new Error("Biometric protected storage verification failed")
        await args.commit(secret, keyId)
        return { ok: true as const }
      } catch (error) {
        // A failed candidate must not replace or delete the previous enrollment.
        await native.deleteData({ key: keyId }).catch(() => undefined)
        throw error
      }
    })
  } catch (error) {
    return failure(error)
  }
}

export async function readNativeBiometricSecret(args: {
  accountId: string
  keyId: string
  prompt: NativeBiometricPrompt
  loader?: Loader
  signal?: AbortSignal
}): Promise<Result<string>> {
  if (!isMobile() || !ownsKey(args.accountId, args.keyId))
    return { ok: false, reason: "unavailable" }
  try {
    return await withBiometricPromptLock(async () => {
      checkAbort(args.signal)
      const native = await (args.loader ?? defaultLoader)()
      checkAbort(args.signal)
      // Do not use getData or a separate verifyIdentity: the native read itself is protected.
      const result = await native.getSecureData({
        key: args.keyId,
        ...args.prompt,
        fallbackTitle: "",
      })
      checkAbort(args.signal)
      if (!/^biometric:[a-f0-9]{64}$/.test(result.value))
        throw new Error("Invalid biometric unlock material")
      return { ok: true as const, value: result.value }
    })
  } catch (error) {
    return failure(error)
  }
}

export async function removeNativeBiometricSecret(
  accountId: string,
  keyId: string,
  loader: Loader = defaultLoader
): Promise<void> {
  if (!ownsKey(accountId, keyId)) throw new Error("Biometric key does not belong to this account")
  if (!isMobile()) return
  await (await loader()).deleteData({ key: keyId })
}
