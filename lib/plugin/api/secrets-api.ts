/**
 * Plugin SecretStorage API — an encrypted, per-plugin secret store.
 *
 * - Native execution host (local Tauri, headless brain, or active remote):
 *   routes through the plugin gateway (`plugin_api_invoke` →
 *   `handle_secrets`), which enforces the `secrets:read`/`secrets:write`
 *   permission tier host-side and persists to the OS keyring, namespaced
 *   `plugin:<id>`.
 * - Standalone browser / mobile: when no gateway host is active, delegate to
 *   the shared `lib/keyring` AES-GCM IndexedDB fallback under the SAME
 *   `plugin:<id>` namespace. Its passphrase is provisioned (once) from the
 *   stable per-install backup key — no user interaction required.
 *
 * A per-plugin key INDEX (key names only — never secret values) is kept in
 * localStorage so `keys()` and purge-on-uninstall can enumerate (the OS keyring
 * cannot list). `onDidChange` fires locally after each store/delete.
 */

import { invokePluginApi, isPluginGatewayAvailable } from "../core/transport"
import { getSecret, setSecret, clearSecret, setWebKeyringPassphrase } from "@/lib/keyring"
import { getDefaultBackupPassphrase } from "@/lib/data/backup-key"
import { loggers } from "../core/logger"
import type { PluginSecretsAPI, PluginSecretsBackend } from "@/types/plugin/plugin"

const namespaceFor = (pluginId: string) => `plugin:${pluginId}`
const indexStorageKey = (pluginId: string) => `cognia.plugin-secrets-index.${pluginId}`

// ── Key index (non-secret key NAMES, for enumerate + purge) ──────────────────

function readIndex(pluginId: string): string[] {
  if (typeof localStorage === "undefined") return []
  try {
    const raw = localStorage.getItem(indexStorageKey(pluginId))
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : []
  } catch {
    return []
  }
}

function writeIndex(pluginId: string, keys: string[]): void {
  if (typeof localStorage === "undefined") return
  try {
    localStorage.setItem(indexStorageKey(pluginId), JSON.stringify([...new Set(keys)]))
  } catch {
    /* storage full / unavailable — index is best-effort */
  }
}

function addToIndex(pluginId: string, key: string): void {
  const keys = readIndex(pluginId)
  if (!keys.includes(key)) writeIndex(pluginId, [...keys, key])
}

function removeFromIndex(pluginId: string, key: string): void {
  writeIndex(
    pluginId,
    readIndex(pluginId).filter((k) => k !== key)
  )
}

// ── onDidChange listeners ────────────────────────────────────────────────────

const listeners = new Map<string, Set<(e: { key: string }) => void>>()

function emitChange(pluginId: string, key: string): void {
  const set = listeners.get(pluginId)
  if (!set) return
  for (const cb of set) {
    try {
      cb({ key })
    } catch (error) {
      loggers.manager.warn(
        `[plugin:${pluginId}] secrets onDidChange listener threw (ignored):`,
        error
      )
    }
  }
}

/** Test-only: clear all secrets listeners. */
export function __resetSecretListenersForTesting(): void {
  listeners.clear()
}

// ── Web passphrase provisioning (browser only, once) ─────────────────────────

let webPassphraseProvisioned = false

async function ensureWebPassphrase(): Promise<void> {
  if (isPluginGatewayAvailable() || webPassphraseProvisioned) return
  const passphrase = await getDefaultBackupPassphrase()
  if (passphrase) {
    setWebKeyringPassphrase(passphrase)
    webPassphraseProvisioned = true
  }
}

/** Reported on `ctx.capabilities` so a plugin can refuse weaker at-rest storage. */
export function getSecretsBackendKind(): PluginSecretsBackend {
  if (isPluginGatewayAvailable()) return "os-keyring"
  return typeof indexedDB !== "undefined" ? "encrypted-web" : "memory"
}

async function readSecret(pluginId: string, key: string): Promise<string | null> {
  if (isPluginGatewayAvailable())
    return invokePluginApi<string | null>(pluginId, "secrets:get", { key })
  await ensureWebPassphrase()
  return getSecret({ namespace: namespaceFor(pluginId), key })
}

export function createSecretsAPI(pluginId: string): PluginSecretsAPI {
  return {
    store: async (key: string, value: string): Promise<void> => {
      if (isPluginGatewayAvailable()) {
        await invokePluginApi<void>(pluginId, "secrets:set", { key, value })
      } else {
        await ensureWebPassphrase()
        await setSecret({ namespace: namespaceFor(pluginId), key }, value)
      }
      addToIndex(pluginId, key)
      emitChange(pluginId, key)
    },

    get: (key: string): Promise<string | null> => readSecret(pluginId, key),

    delete: async (key: string): Promise<void> => {
      if (isPluginGatewayAvailable()) {
        await invokePluginApi<void>(pluginId, "secrets:delete", { key })
      } else {
        await ensureWebPassphrase()
        await clearSecret({ namespace: namespaceFor(pluginId), key })
      }
      removeFromIndex(pluginId, key)
      emitChange(pluginId, key)
    },

    has: async (key: string): Promise<boolean> => (await readSecret(pluginId, key)) !== null,

    keys: async (): Promise<string[]> => readIndex(pluginId),

    onDidChange: (listener: (e: { key: string }) => void): (() => void) => {
      let set = listeners.get(pluginId)
      if (!set) {
        set = new Set()
        listeners.set(pluginId, set)
      }
      set.add(listener)
      return () => {
        set?.delete(listener)
      }
    },
  }
}

/**
 * Purge every secret a plugin stored (used on uninstall). Reads the key index,
 * deletes each entry through the active backend, then clears the index. The
 * Tauri path deletes via the gateway; browser via the keyring web fallback.
 */
export async function clearPluginSecrets(pluginId: string): Promise<void> {
  const keys = readIndex(pluginId)
  for (const key of keys) {
    try {
      if (isPluginGatewayAvailable()) {
        await invokePluginApi<void>(pluginId, "secrets:delete", { key })
      } else {
        await ensureWebPassphrase()
        await clearSecret({ namespace: namespaceFor(pluginId), key })
      }
    } catch (error) {
      loggers.manager.warn(
        `[plugin:${pluginId}] secret purge failed for "${key}" (ignored):`,
        error
      )
    }
  }
  writeIndex(pluginId, [])
  listeners.delete(pluginId)
}
