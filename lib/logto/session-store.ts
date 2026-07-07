/**
 * Persistence for the active Logto session (ADR-0059 cloud/headless — Logto).
 *
 * Tokens are kept in the OS keyring (desktop) / AES-GCM IndexedDB fallback
 * (web) via `lib/keyring`, off the plaintext Dexie store — the same vault used
 * for connector / subscription credentials. One JSON blob per active session.
 */

import { getSecret, setSecret, clearSecret, type KeyringRef } from "@/lib/keyring"

import type { LogtoSession } from "./client"

/** Keyring location of the active Logto session. */
export const LOGTO_KEYRING: KeyringRef = { namespace: "logto", key: "session" }

/** Persist (upsert) the active Logto session. */
export async function saveLogtoSession(session: LogtoSession): Promise<void> {
  await setSecret(LOGTO_KEYRING, JSON.stringify(session))
}

/** Load the active Logto session, or `null` if none is stored / it is corrupt. */
export async function loadLogtoSession(): Promise<LogtoSession | null> {
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
  await clearSecret(LOGTO_KEYRING)
}
