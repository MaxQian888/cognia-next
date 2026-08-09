/**
 * Frontend wrapper over the Tauri-side TTS keyring commands. Falls back to
 * an IndexedDB store when running in pure web mode (no Tauri).
 *
 * The active key set is mirrored into Zustand at app boot so the
 * orchestrator can read keys synchronously while playing.
 */

import { isTauri } from "@/lib/tauri"
import { getDb } from "@/lib/db/schema"
import { KEYED_TTS_PROVIDERS, type TTSProvider } from "@cognia/tts/types"
import { createKeyringStore } from "@/lib/credentials/keyring-store"

/** Stable provider keys understood by the keyring backend. */
export type KeyringProviderId =
  | "openai"
  | "google"
  | "elevenlabs"
  | "lmnt"
  | "hume"
  | "cartesia"
  | "deepgram"
  | "xiaomi"
  | "mistral"
  | "local-openai-compatible"
  /** Live voice only — xAI has no TTS provider, so `keyringProviderFor` never returns it. */
  | "xai"

export const KEYRING_PROVIDER_IDS: KeyringProviderId[] = [
  "openai",
  "google",
  "elevenlabs",
  "lmnt",
  "hume",
  "cartesia",
  "deepgram",
  "xiaomi",
  "mistral",
  "local-openai-compatible",
  "xai",
]

/** Presence-only marker used in the renderer for desktop keyring entries. */
export const HOST_KEY_PRESENT = "__cognia_host_key_present__"

/** Map a TTSProvider → the keyring account it consumes. */
export function keyringProviderFor(provider: TTSProvider): KeyringProviderId | null {
  switch (provider) {
    case "openai":
    case "openai-realtime":
      return "openai"
    case "gemini":
      return "google"
    case "elevenlabs":
      return "elevenlabs"
    case "lmnt":
      return "lmnt"
    case "hume":
      return "hume"
    case "cartesia":
      return "cartesia"
    case "deepgram":
      return "deepgram"
    case "xiaomi":
      return "xiaomi"
    case "mistral":
      return "mistral"
    case "local-openai-compatible":
      return "local-openai-compatible"
    default:
      return null
  }
}

const WEB_STORE_KEY_PREFIX = "tts.providerKey."
const webSecretStore = createKeyringStore("tts")

export async function getProviderKey(provider: KeyringProviderId): Promise<string | null> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core")
    const value = await invoke<string | null>("tts_keyring_get", { provider })
    return value && value.length > 0 ? value : null
  }
  return webStoreGet(provider)
}

export async function setProviderKey(provider: KeyringProviderId, key: string): Promise<void> {
  const trimmed = key.trim()
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core")
    if (!trimmed) {
      await invoke("tts_keyring_delete", { provider })
    } else {
      await invoke("tts_keyring_set", { provider, key: trimmed })
    }
    return
  }
  if (!trimmed) {
    await webStoreDelete(provider)
  } else {
    await webStoreSet(provider, trimmed)
  }
}

export async function clearProviderKey(provider: KeyringProviderId): Promise<void> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core")
    await invoke("tts_keyring_delete", { provider })
    return
  }
  await webStoreDelete(provider)
}

/** Returns a record of provider → key. Missing providers are omitted. */
export async function loadAllProviderKeys(): Promise<Partial<Record<KeyringProviderId, string>>> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core")
    const ids = await invoke<KeyringProviderId[]>("tts_keyring_list_providers")
    const out: Partial<Record<KeyringProviderId, string>> = {}
    for (const id of ids) out[id] = HOST_KEY_PRESENT
    return out
  }
  const out: Partial<Record<KeyringProviderId, string>> = {}
  for (const id of KEYRING_PROVIDER_IDS) {
    const key = await webStoreGet(id)
    if (key) out[id] = key
  }
  return out
}

/**
 * Convert the in-memory `providerKeys` map into the shape the orchestrator
 * expects for `providerSettings.openai?.apiKey` lookups.
 */
export function providerKeyMapToSettingsMap(
  keys: Partial<Record<KeyringProviderId, string>>
): Record<string, { apiKey?: string }> {
  const out: Record<string, { apiKey?: string }> = {}
  for (const id of KEYRING_PROVIDER_IDS) {
    if (keys[id]) out[id] = { apiKey: keys[id] === HOST_KEY_PRESENT ? "host-key" : keys[id] }
  }
  return out
}

/** True when the active TTS provider needs a configured key to be usable. */
export function isProviderKeyMissing(
  provider: TTSProvider,
  keys: Partial<Record<KeyringProviderId, string>>
): boolean {
  const required = KEYED_TTS_PROVIDERS.includes(provider)
  if (!required) return false
  const id = keyringProviderFor(provider)
  if (!id) return true
  return !keys[id]
}

// ---- Web fallback: Browser Vault (legacy Dexie rows are read/migrated) -----

async function webStoreGet(provider: KeyringProviderId): Promise<string | null> {
  if (typeof indexedDB === "undefined") return null
  try {
    const stored = await webSecretStore.load(provider)
    if (stored) return stored
    const row = await getDb().tts_provider_keys.get(WEB_STORE_KEY_PREFIX + provider)
    const legacy = row?.value ?? null
    if (!legacy) return null
    await webSecretStore.save(provider, legacy)
    if (webSecretStore.isPersistent?.()) {
      await getDb().tts_provider_keys.delete(WEB_STORE_KEY_PREFIX + provider)
    }
    return legacy
  } catch {
    return null
  }
}

async function webStoreSet(provider: KeyringProviderId, value: string): Promise<void> {
  if (typeof indexedDB === "undefined") return
  await webSecretStore.save(provider, value)
  // Remove a legacy cleartext row only after the secure/session adapter has
  // accepted the new value. Deletion is idempotent.
  await getDb()
    .tts_provider_keys.delete(WEB_STORE_KEY_PREFIX + provider)
    .catch(() => undefined)
}

async function webStoreDelete(provider: KeyringProviderId): Promise<void> {
  if (typeof indexedDB === "undefined") return
  await webSecretStore.delete(provider)
  await getDb()
    .tts_provider_keys.delete(WEB_STORE_KEY_PREFIX + provider)
    .catch(() => undefined)
}
