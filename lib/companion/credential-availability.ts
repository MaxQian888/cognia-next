/**
 * Why `companionStorage().load()` came back null.
 *
 * `CredentialBookCompanionStorage.load()` answers `null` for four unrelated
 * reasons — no account namespace, no host record under the active runtime
 * target, a Vault that refuses to decrypt, and a record whose credential was
 * never written — and its callers turn all four into the single sentence "The
 * selected Web Host credential is unavailable." That sentence is true of every
 * one of them and actionable for none: one is "sign in", one is "pair", one is
 * "unlock", and one is a half-written pairing that has to be removed.
 *
 * Collapsing a locked Vault into "unpaired" is deliberate *inside* `load()` —
 * every caller of it needs a token and there is none. The mistake was letting
 * that collapse reach the screen. This module re-derives the distinction from
 * the same book, after the fact, for the one caller that has to explain itself
 * to a human.
 */

import {
  BrowserVaultLockedError,
  companionCredentialBook,
  type CompanionCredentialBook,
  type CompanionHostRecord,
} from "./credential-book"
import { getActiveRuntimeTargetContext } from "@/lib/runtime/runtime-target-context"

export type CompanionCredentialAvailability =
  /** `load()` would succeed — the null was transient, or something else moved. */
  | "available"
  /** No active runtime target context: nothing has selected an account yet. */
  | "no-active-account"
  /** The active target has no paired-host record: this client is not paired. */
  | "no-host-record"
  /** A record exists but the Vault refused to hand over the key. */
  | "vault-locked"
  /** A record exists and the Vault is open, but no credential was ever stored. */
  | "no-credential"
  /** The credential stores could not be read or contained invalid data. */
  | "storage-error"

export interface CompanionCredentialDiagnosis {
  reason: CompanionCredentialAvailability
  /** The host id the lookup used, when there was one. */
  hostId?: string
  /** The account namespace the lookup used, when there was one. */
  accountNamespace?: string
  /** Diagnostic detail for unexpected storage failures. */
  error?: string
}

export interface DiagnoseCompanionCredentialDeps {
  book?: CompanionCredentialBook
  activeContext?: () => { accountId: string; targetId: string } | null
}

/**
 * Re-run the `load()` lookup one step at a time and report where it stopped.
 *
 * Read-only: it never writes the book, never installs a transport, and never
 * changes the active pointer. Safe to call on a failure path.
 */
export async function diagnoseCompanionCredential(
  deps: DiagnoseCompanionCredentialDeps = {}
): Promise<CompanionCredentialDiagnosis> {
  const book = deps.book ?? companionCredentialBook()
  const context = (deps.activeContext ?? getActiveRuntimeTargetContext)()
  if (!context) return { reason: "no-active-account" }

  const accountNamespace = context.accountId
  const hostId = context.targetId
  let record: CompanionHostRecord | null = null
  try {
    record = await book.get({ accountNamespace, hostId })
  } catch (error) {
    return {
      reason: "storage-error",
      accountNamespace,
      hostId,
      error: error instanceof Error ? error.message : String(error),
    }
  }
  if (!record) return { reason: "no-host-record", accountNamespace, hostId }

  try {
    const credential = await book.loadCredential({ accountNamespace, hostId })
    if (!credential) return { reason: "no-credential", accountNamespace, hostId }
  } catch (error) {
    if (error instanceof BrowserVaultLockedError) {
      return { reason: "vault-locked", accountNamespace, hostId }
    }
    return {
      reason: "storage-error",
      accountNamespace,
      hostId,
      error: error instanceof Error ? error.message : String(error),
    }
  }
  return { reason: "available", accountNamespace, hostId }
}

/**
 * A one-line explanation for the runtime error the boot provider throws.
 *
 * English, not `next-intl`: this string is a technical detail rendered inside
 * the pairing panel's `{message}` slot and copied into bug reports, alongside
 * stack frames and HTTP codes. The user-facing sentence around it is
 * translated; this is the part a maintainer reads.
 */
export function describeCompanionCredentialDiagnosis(
  diagnosis: CompanionCredentialDiagnosis
): string {
  const where =
    diagnosis.hostId !== undefined
      ? ` (host ${diagnosis.hostId} in account ${diagnosis.accountNamespace})`
      : ""
  switch (diagnosis.reason) {
    case "no-active-account":
      return "no runtime target is active, so no Host credential could be selected"
    case "no-host-record":
      return `no paired-Host record exists for the active runtime target${where}`
    case "vault-locked":
      return `the Browser Vault refused to decrypt the device key${where}`
    case "no-credential":
      return `the Host record exists but its device key was never stored${where}`
    case "available":
      return `the Host credential is readable now${where} — the failure was transient`
    case "storage-error":
      return `the Host credential store could not be read${where}: ${diagnosis.error ?? "unknown storage error"}`
  }
}
