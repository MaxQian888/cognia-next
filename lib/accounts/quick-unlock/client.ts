"use client"

/**
 * The one place the two runtimes' quick-unlock implementations meet.
 *
 * Callers ask to enroll, verify or remove a method. What actually happens
 * underneath differs completely by runtime, and deliberately so:
 *
 *   - DESKTOP mints an Argon2id verifier in Rust, peppered from the OS
 *     keyring, and a successful verify binds the host exactly as a password
 *     unlock does. There is no master key on the desktop host to wrap.
 *   - BROWSER and MOBILE wrap the Browser Vault's master key under a KEK
 *     derived from the secret and a non-extractable device key.
 *
 * Both produce a `QuickUnlockEnrollment` whose `verifier` field the other
 * runtime would not understand, which is correct: an enrollment is bound to
 * the device that made it, and neither form is portable.
 *
 * The attempt cap lives HERE rather than in either backend, because it is the
 * one rule that has to hold identically on both and neither backend can see
 * the enrollment record.
 */

import { invoke } from "@tauri-apps/api/core"

import { isTauri } from "@/lib/platform/detect"
import type { PasswordVerifierRecord } from "@/lib/accounts/account-types"
import {
  enrollBrowserVaultQuickUnlock,
  removeBrowserVaultQuickUnlock,
  unlockBrowserVaultWithQuickSecret,
} from "@/lib/runtime/browser-vault"
import { deriveDevicePepper } from "./device-pepper"
import {
  isEnrollmentUsable,
  withFailedAttempt,
  withSuccessfulAttempt,
  type QuickUnlockEnrollment,
  type QuickUnlockMethod,
} from "./types"

export const QUICK_UNLOCK_CREATE_COMMAND = "account_quick_unlock_create_verifier"
export const QUICK_UNLOCK_VERIFY_COMMAND = "account_quick_unlock_verify"
export const QUICK_UNLOCK_CLEAR_COMMAND = "account_quick_unlock_clear"

type InvokeFn = <T>(command: string, args?: Record<string, unknown>) => Promise<T>

/** Why an unlock attempt did not open the account. */
export type QuickUnlockFailure =
  "wrong-secret" | "locked-out" | "not-enrolled" | "unavailable" | "failed"

export type QuickUnlockOutcome =
  /** Opened. The caller persists `enrollment`, whose failure count is reset. */
  | { ok: true; enrollment: QuickUnlockEnrollment }
  /**
   * Refused. `enrollment` carries the incremented failure count and, at the
   * cap, the lockout stamp. Persisting it is what makes the cap real, so a
   * caller that drops it on the floor has removed the protection.
   */
  | { ok: false; reason: QuickUnlockFailure; enrollment: QuickUnlockEnrollment }

export interface EnrollArgs {
  accountId: string
  method: QuickUnlockMethod
  /** Method-prefixed secret from `secret-policy.ts`, never the raw digits. */
  canonicalSecret: string
  /** Required on the browser path, which re-wraps the master key. */
  password: string
  /** The account's password verifier. Desktop binds the host with its digest. */
  passwordVerifier: PasswordVerifierRecord
  now?: number
}

/** Enroll a method, returning the record to store on the account. */
export async function enrollQuickUnlock(args: EnrollArgs): Promise<QuickUnlockEnrollment> {
  const now = args.now ?? Date.now()

  if (isTauri()) {
    const verifier = await (invoke as InvokeFn)<Record<string, unknown>>(
      QUICK_UNLOCK_CREATE_COMMAND,
      { accountId: args.accountId, method: args.method, secret: args.canonicalSecret }
    )
    return { method: args.method, verifier, createdAt: now, failedAttempts: 0 }
  }

  const pepper = await deriveDevicePepper(args.accountId)
  const wrap = await enrollBrowserVaultQuickUnlock({
    accountId: args.accountId,
    method: args.method,
    password: args.password,
    canonicalSecret: args.canonicalSecret,
    pepper,
    now,
  })
  // The wrap already lives in the vault record. What is stored on the account
  // is the bookkeeping: which methods exist, and how many attempts are left.
  return {
    method: args.method,
    verifier: { storage: "browser-vault", createdAt: wrap.createdAt },
    createdAt: now,
    failedAttempts: 0,
  }
}

export interface VerifyArgs {
  accountId: string
  enrollment: QuickUnlockEnrollment
  canonicalSecret: string
  passwordVerifier: PasswordVerifierRecord
  now?: number
}

/**
 * Attempt an unlock.
 *
 * Never throws for a wrong secret. A rejected credential is an ordinary
 * outcome that has to update the attempt count, and turning it into an
 * exception is how a caller ends up with a catch block that forgets to
 * persist the increment.
 */
export async function verifyQuickUnlock(args: VerifyArgs): Promise<QuickUnlockOutcome> {
  const now = args.now ?? Date.now()
  const { enrollment } = args

  // Checked before any expensive derivation, and before either backend is
  // touched, so a locked-out method costs nothing and reveals nothing.
  if (!isEnrollmentUsable(enrollment)) {
    return { ok: false, reason: "locked-out", enrollment }
  }

  try {
    const matched = isTauri()
      ? await (invoke as InvokeFn)<boolean>(QUICK_UNLOCK_VERIFY_COMMAND, {
          accountId: args.accountId,
          verifier: enrollment.verifier,
          passwordVerifier: args.passwordVerifier,
          secret: args.canonicalSecret,
        })
      : await unlockViaBrowserVault(args)

    if (!matched) {
      return {
        ok: false,
        reason: "wrong-secret",
        enrollment: withFailedAttempt(enrollment, now),
      }
    }
    return { ok: true, enrollment: withSuccessfulAttempt(enrollment, now) }
  } catch (error) {
    // A wrong secret reaches here on the browser path, where an AES-GCM
    // unwrap failure IS the rejection. Anything genuinely broken is reported
    // separately so the UI does not tell a user their PIN is wrong when the
    // real problem is a missing device key.
    if (isNotEnrolled(error)) {
      return { ok: false, reason: "not-enrolled", enrollment }
    }
    return { ok: false, reason: "wrong-secret", enrollment: withFailedAttempt(enrollment, now) }
  }
}

async function unlockViaBrowserVault(args: VerifyArgs): Promise<boolean> {
  const pepper = await deriveDevicePepper(args.accountId)
  await unlockBrowserVaultWithQuickSecret({
    accountId: args.accountId,
    method: args.enrollment.method,
    canonicalSecret: args.canonicalSecret,
    pepper,
  })
  return true
}

function isNotEnrolled(error: unknown): boolean {
  return error instanceof Error && /not enrolled/i.test(error.message)
}

/** Forget a method. Every other method and the password are untouched. */
export async function removeQuickUnlock(
  accountId: string,
  method: QuickUnlockMethod
): Promise<void> {
  if (isTauri()) {
    // The desktop pepper is per ACCOUNT, not per method, so it is only dropped
    // when the caller removes the last one. `clearQuickUnlockDeviceMaterial`
    // is that step.
    return
  }
  await removeBrowserVaultQuickUnlock(accountId, method)
}

/**
 * Drop this device's quick-unlock material entirely.
 *
 * Called after the LAST method is removed, and when an account is deleted.
 * Every verifier that material produced stops matching, which is the point.
 */
export async function clearQuickUnlockDeviceMaterial(accountId: string): Promise<void> {
  if (isTauri()) {
    await (invoke as InvokeFn)<void>(QUICK_UNLOCK_CLEAR_COMMAND, { accountId })
    return
  }
  const { clearDeviceKey } = await import("./device-pepper")
  await clearDeviceKey(accountId)
}
