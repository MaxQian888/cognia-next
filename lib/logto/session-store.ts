/**
 * Persistence for the active Logto session (ADR-0059 cloud/headless — Logto).
 *
 * Tokens are kept in the OS keyring (desktop) / AES-GCM IndexedDB fallback
 * (phone and browser) via `lib/keyring`, off the plaintext Dexie store — the
 * same vault used for connector / subscription credentials. One JSON blob per
 * active session.
 *
 * The non-desktop fallback needs an encryption passphrase injected before it
 * will accept a write; without one, reads return null and writes throw. Nothing
 * injected it for Logto, so signing in anywhere but the desktop would have
 * failed at the moment the token was persisted — after a successful browser
 * round-trip, which is the worst possible place to discover it. We provision it
 * the same way `lib/plugin/api/secrets-api.ts` does, from the backup auto-key.
 *
 * ## One session per LocalProfile (ADR-0149)
 *
 * The session used to live at a single global key, so two LocalProfiles on one
 * machine shared one login — which is exactly the conflation ADR-0149 exists to
 * undo: a profile is an encryption boundary and the person signed into it is a
 * separate fact. The key is now scoped by profile.
 *
 * A blob left at the legacy global key is DELETED rather than adopted. Nothing
 * records which profile it belonged to, and guessing would show one person's
 * token inside another person's profile. Signing in again is cheap; being
 * quietly signed in as somebody else is not.
 */

import {
  getSecret,
  setSecret,
  clearSecret,
  setWebKeyringPassphrase,
  type KeyringRef,
} from "@/lib/keyring"
import { getActiveAccountId } from "@/lib/accounts/active-account-id"
import { getDefaultBackupPassphrase } from "@/lib/data/backup-key"
import { isTauri } from "@/lib/tauri"

import type { LogtoSession, LogtoSessionMetadata } from "./client"

export const LOGTO_KEYRING_NAMESPACE = "logto"

/**
 * What is left after a refresh proves the stored login dead.
 *
 * The tokens are gone, and nothing should ever present them again. The UI
 * still has to say WHO needs to sign in again and WHERE, which is what the
 * non-secret metadata is for. Stored beside the session, never inside it, so
 * `loadLogtoSession` keeps meaning "a session with tokens".
 */
export interface LogtoReauthMarker {
  reason: "expired" | "revoked"
  metadata: LogtoSessionMetadata
  /** Epoch ms at which the refresh was refused. */
  at: number
}

/**
 * The pre-ADR-0149 global key. Read only to delete it — see the header.
 */
export const LEGACY_LOGTO_KEYRING: KeyringRef = {
  namespace: LOGTO_KEYRING_NAMESPACE,
  key: "session",
}

/**
 * Keyring location of one LocalProfile's Logto session.
 *
 * The profile defaults to whichever one this runtime is serving —
 * `getActiveAccountId()` derives it from the open Dexie database name, so there
 * is no second "current profile" to drift from it. Callers pass an explicit id
 * only when acting on a profile other than the open one.
 */
export function logtoKeyringFor(localAccountId = getActiveAccountId()): KeyringRef {
  return { namespace: LOGTO_KEYRING_NAMESPACE, key: `session:${localAccountId}` }
}

/** Keyring location of the re-authentication marker for one LocalProfile. */
export function logtoReauthKeyringFor(localAccountId = getActiveAccountId()): KeyringRef {
  return { namespace: LOGTO_KEYRING_NAMESPACE, key: `reauth:${localAccountId}` }
}

let webPassphraseProvisioned = false

/**
 * Give the encrypted-IndexedDB fallback its key, once, off the desktop.
 *
 * Deliberately not fatal when no passphrase is available: the caller should get
 * the keyring's own error at the point of the read or write, which names the
 * actual problem, rather than a second error from here that hides it.
 */
async function ensureWebPassphrase(): Promise<void> {
  if (isTauri() || webPassphraseProvisioned) return
  const passphrase = await getDefaultBackupPassphrase()
  if (passphrase) {
    setWebKeyringPassphrase(passphrase)
    webPassphraseProvisioned = true
  }
}

/** Test-only: forget that provisioning already ran. */
export function __resetLogtoWebPassphraseForTests(): void {
  webPassphraseProvisioned = false
}

/**
 * Persist (upsert) this profile's Logto session.
 *
 * A fresh session supersedes any re-authentication marker: the marker says
 * "sign in again", and this is that sign-in having happened.
 */
export async function saveLogtoSession(
  session: LogtoSession,
  localAccountId?: string
): Promise<void> {
  await ensureWebPassphrase()
  await setSecret(logtoKeyringFor(localAccountId), JSON.stringify(session))
  await clearSecret(logtoReauthKeyringFor(localAccountId))
}

/** Load this profile's Logto session, or `null` if none is stored / it is corrupt. */
export async function loadLogtoSession(localAccountId?: string): Promise<LogtoSession | null> {
  await ensureWebPassphrase()
  const raw = await getSecret(logtoKeyringFor(localAccountId))
  if (!raw) return null
  try {
    return JSON.parse(raw) as LogtoSession
  } catch {
    return null
  }
}

/** Remove this profile's Logto session (sign out). Idempotent. */
export async function clearLogtoSession(localAccountId?: string): Promise<void> {
  await ensureWebPassphrase()
  await clearSecret(logtoKeyringFor(localAccountId))
}

/**
 * Replace a dead session with its marker, atomically enough: the marker is
 * written first, so a crash between the two leaves "sign in again" visible
 * rather than a blank where a login used to be.
 */
export async function markLogtoSessionForReauth(
  marker: LogtoReauthMarker,
  localAccountId?: string
): Promise<void> {
  await ensureWebPassphrase()
  await setSecret(logtoReauthKeyringFor(localAccountId), JSON.stringify(marker))
  await clearSecret(logtoKeyringFor(localAccountId))
}

/** The marker left by a refused refresh, or `null` when there is none / it is corrupt. */
export async function loadLogtoReauthMarker(
  localAccountId?: string
): Promise<LogtoReauthMarker | null> {
  await ensureWebPassphrase()
  const raw = await getSecret(logtoReauthKeyringFor(localAccountId))
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<LogtoReauthMarker>
    if (
      (parsed.reason !== "expired" && parsed.reason !== "revoked") ||
      typeof parsed.metadata !== "object" ||
      parsed.metadata === null ||
      typeof parsed.metadata.issuer !== "string"
    ) {
      return null
    }
    return parsed as LogtoReauthMarker
  } catch {
    return null
  }
}

/** Forget the re-authentication marker. Idempotent. */
export async function clearLogtoReauthMarker(localAccountId?: string): Promise<void> {
  await ensureWebPassphrase()
  await clearSecret(logtoReauthKeyringFor(localAccountId))
}

/**
 * Drop any session left at the pre-ADR-0149 global key.
 *
 * Idempotent and safe to call on every boot. It deletes rather than migrates,
 * because the blob carries no record of which profile it belonged to.
 */
export async function discardLegacyGlobalLogtoSession(): Promise<boolean> {
  await ensureWebPassphrase()
  const raw = await getSecret(LEGACY_LOGTO_KEYRING)
  if (!raw) return false
  await clearSecret(LEGACY_LOGTO_KEYRING)
  return true
}
