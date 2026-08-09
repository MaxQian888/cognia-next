"use client"

import { createLocalKeyringStore, type KeyringStore } from "@/lib/credentials/keyring-store"
import type { LegacyNetworkProxySettings, NetworkProxySettings } from "@/types/network/proxy"

export const NETWORK_PROXY_KEYRING_NAMESPACE = "cognia-network-proxy"
export const NETWORK_PROXY_PASSWORD_KEY = "manual-password"

export type ProxyPasswordMutation =
  { kind: "keep" } | { kind: "replace"; value: string } | { kind: "clear" }

export interface ProxyCredentialMigrationResult {
  settings: NetworkProxySettings
  credentialConfigured: boolean
  migrated: boolean
}

function keyring(): KeyringStore {
  return createLocalKeyringStore(NETWORK_PROXY_KEYRING_NAMESPACE)
}

function withoutLegacyPassword(settings: LegacyNetworkProxySettings): NetworkProxySettings {
  const sanitized = { ...settings }
  delete sanitized.password
  return sanitized
}

export async function isProxyPasswordConfigured(): Promise<boolean> {
  return (await keyring().load(NETWORK_PROXY_PASSWORD_KEY)) !== null
}

/**
 * Move a password written by older releases out of Dexie. The caller must
 * persist `settings` only after this function succeeds; on failure the legacy
 * row remains available for a later retry and the proxy must stay blocked.
 */
export async function migrateLegacyProxyPassword(
  settings: LegacyNetworkProxySettings,
  persistSanitized?: (settings: NetworkProxySettings) => Promise<void>
): Promise<ProxyCredentialMigrationResult> {
  const legacyPassword = settings.password
  const sanitized = withoutLegacyPassword(settings)

  if (legacyPassword === undefined) {
    const result = {
      settings: sanitized,
      credentialConfigured: await isProxyPasswordConfigured(),
      migrated: false,
    }
    return result
  }

  const store = keyring()
  if (legacyPassword.length === 0) {
    await store.delete(NETWORK_PROXY_PASSWORD_KEY)
  } else {
    await store.save(NETWORK_PROXY_PASSWORD_KEY, legacyPassword)
  }

  const saved = await store.load(NETWORK_PROXY_PASSWORD_KEY)
  const expected = legacyPassword.length === 0 ? null : legacyPassword
  if (saved !== expected) {
    throw new Error("PROXY_CREDENTIAL_UNAVAILABLE")
  }

  if (persistSanitized) await persistSanitized(sanitized)

  return {
    settings: sanitized,
    credentialConfigured: saved !== null,
    migrated: true,
  }
}

/** Apply the password editor's explicit keep / replace / clear intent. */
export async function applyProxyPasswordMutation(
  mutation: ProxyPasswordMutation
): Promise<boolean> {
  const store = keyring()
  if (mutation.kind === "keep") {
    return (await store.load(NETWORK_PROXY_PASSWORD_KEY)) !== null
  }
  if (mutation.kind === "clear") {
    await store.delete(NETWORK_PROXY_PASSWORD_KEY)
    if ((await store.load(NETWORK_PROXY_PASSWORD_KEY)) !== null) {
      throw new Error("PROXY_CREDENTIAL_UNAVAILABLE")
    }
    return false
  }

  if (!mutation.value) throw new Error("PROXY_CREDENTIAL_UNAVAILABLE")
  await store.save(NETWORK_PROXY_PASSWORD_KEY, mutation.value)
  const saved = await store.load(NETWORK_PROXY_PASSWORD_KEY)
  if (saved !== mutation.value) throw new Error("PROXY_CREDENTIAL_UNAVAILABLE")
  return true
}
