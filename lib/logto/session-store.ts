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
 */

import {
  getSecret,
  setSecret,
  clearSecret,
  setWebKeyringPassphrase,
  type KeyringRef,
} from "@/lib/keyring"
import { getDefaultBackupPassphrase } from "@/lib/data/backup-key"
import { isTauri } from "@/lib/tauri"

import type { LogtoSession } from "./client"

/** Keyring location of the active Logto session. */
export const LOGTO_KEYRING: KeyringRef = { namespace: "logto", key: "session" }

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

/** Persist (upsert) the active Logto session. */
export async function saveLogtoSession(session: LogtoSession): Promise<void> {
  await ensureWebPassphrase()
  await setSecret(LOGTO_KEYRING, JSON.stringify(session))
}

/** Load the active Logto session, or `null` if none is stored / it is corrupt. */
export async function loadLogtoSession(): Promise<LogtoSession | null> {
  await ensureWebPassphrase()
  const raw = await getSecret(LOGTO_KEYRING)
  if (!raw) return null
  try {
    return JSON.parse(raw) as LogtoSession
  } catch {
    return null
  }
}

/** Remove the active Logto session (sign out). Idempotent. */
export async function clearLogtoSession(): Promise<void> {
  await ensureWebPassphrase()
  await clearSecret(LOGTO_KEYRING)
}
