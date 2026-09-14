/**
 * Plugin Storage API Implementation
 *
 * Provides per-plugin storage: localStorage on browser/desktop, owned plugin
 * records on Headless so acknowledged writes participate in host durability.
 * Each plugin gets an isolated namespace to prevent conflicts.
 */

import { getDb } from "@/lib/db/schema"
import { isHeadlessHost } from "@/lib/platform/detect"
import { createPluginSystemLogger } from "../core/logger"
import { deriveKey, deriveInstallKey, encrypt, decrypt } from "./crypto-helpers"

export interface PluginStorageAPI {
  /** Get a value by key */
  get<T = unknown>(key: string): Promise<T | undefined>
  /** Get a value by key with a default */
  getOrDefault<T = unknown>(key: string, defaultValue: T): Promise<T>
  /** Set a value by key */
  set<T = unknown>(key: string, value: T): Promise<void>
  /** Remove a value by key */
  remove(key: string): Promise<void>
  /** Delete alias for compatibility with legacy PluginStorage */
  delete(key: string): Promise<void>
  /** Check if a key exists */
  has(key: string): Promise<boolean>
  /** Get all keys in this plugin's namespace */
  keys(): Promise<string[]>
  /** Clear all plugin storage */
  clear(): Promise<void>
  /** Get storage usage in bytes (approximate) */
  getUsage(): Promise<number>
  /** Store a value with AES-GCM encryption */
  setSecure<T = unknown>(key: string, value: T): Promise<void>
  /** Retrieve and decrypt a securely stored value */
  getSecure<T = unknown>(key: string): Promise<T | undefined>
  /** Check if a value is stored with encryption */
  isEncrypted(key: string): Promise<boolean>
}

const STORAGE_PREFIX = "cognia:plugin:storage:"
const ENCRYPTED_PREFIX = "__encrypted:"
const MAX_PLUGIN_STORAGE_BYTES = 5 * 1024 * 1024 // 5MB per plugin

function getStorageKey(pluginId: string, key: string): string {
  return `${STORAGE_PREFIX}${pluginId}:${key}`
}

function getPluginPrefix(pluginId: string): string {
  return `${STORAGE_PREFIX}${pluginId}:`
}

/** Reads and changes serialize with plugin discovery; no credentials or global Storage are copied. */
async function withHeadlessStorage<T>(
  pluginId: string,
  mutate: boolean,
  fn: (values: Record<string, string>) => T
): Promise<T> {
  const db = getDb()
  return db.transaction("rw", db.plugins, async () => {
    const plugin = await db.plugins.get(pluginId)
    if (!plugin) throw new Error("Plugin storage owner is not installed")
    const values = Object.assign(Object.create(null) as Record<string, string>, plugin.storage)
    if (plugin.storage === undefined && typeof localStorage !== "undefined") {
      const prefix = getPluginPrefix(pluginId)
      for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index)
        if (!key?.startsWith(prefix)) continue
        const raw = localStorage.getItem(key)
        if (raw !== null) values[key.slice(prefix.length)] = raw
      }
    }
    const result = fn(values)
    if (mutate || plugin.storage === undefined) {
      const size = Object.entries(values).reduce(
        (total, [key, value]) => total + 2 * (getStorageKey(pluginId, key).length + value.length),
        0
      )
      if (size > MAX_PLUGIN_STORAGE_BYTES)
        throw new Error(`Plugin storage limit exceeded (${MAX_PLUGIN_STORAGE_BYTES} bytes)`)
      await db.plugins.update(pluginId, { storage: values })
    }
    return result
  })
}

/**
 * Create the Storage API for a plugin
 */
export function createStorageAPI(pluginId: string): PluginStorageAPI {
  const logger = createPluginSystemLogger(pluginId)
  const prefix = getPluginPrefix(pluginId)
  const durable = isHeadlessHost()

  return {
    async get<T = unknown>(key: string): Promise<T | undefined> {
      try {
        const raw = durable
          ? await withHeadlessStorage(pluginId, false, (values) => values[key] ?? null)
          : localStorage.getItem(getStorageKey(pluginId, key))
        if (raw === null) return undefined
        return JSON.parse(raw) as T
      } catch (error) {
        if (durable) throw error
        logger.warn(`Failed to read storage key: ${key}`)
        return undefined
      }
    },

    async getOrDefault<T = unknown>(key: string, defaultValue: T): Promise<T> {
      const value = await this.get<T>(key)
      return value !== undefined ? value : defaultValue
    },

    async set<T = unknown>(key: string, value: T): Promise<void> {
      try {
        const serialized = JSON.stringify(value)
        if (durable) {
          if (serialized === undefined) throw new TypeError("Plugin storage requires a JSON value")
          await withHeadlessStorage(pluginId, true, (values) => {
            values[key] = serialized
          })
          return
        }

        // Check size limit
        const currentUsage = await this.getUsage()
        const newEntrySize = getStorageKey(pluginId, key).length + serialized.length
        const existingRaw = localStorage.getItem(getStorageKey(pluginId, key))
        const existingSize = existingRaw
          ? getStorageKey(pluginId, key).length + existingRaw.length
          : 0

        if (currentUsage - existingSize + newEntrySize > MAX_PLUGIN_STORAGE_BYTES) {
          throw new Error(
            `Plugin storage limit exceeded (${MAX_PLUGIN_STORAGE_BYTES} bytes). ` +
              `Current: ${currentUsage}, New entry: ${newEntrySize}`
          )
        }

        localStorage.setItem(getStorageKey(pluginId, key), serialized)
      } catch (err) {
        if (durable || (err instanceof Error && err.message.includes("storage limit"))) {
          throw err
        }
        logger.error(`Failed to write storage key: ${key}`, err)
      }
    },

    async remove(key: string): Promise<void> {
      if (durable)
        return withHeadlessStorage(pluginId, true, (values) => {
          delete values[key]
        })
      localStorage.removeItem(getStorageKey(pluginId, key))
    },

    async has(key: string): Promise<boolean> {
      if (durable)
        return withHeadlessStorage(pluginId, false, (values) => Object.hasOwn(values, key))
      return localStorage.getItem(getStorageKey(pluginId, key)) !== null
    },

    async keys(): Promise<string[]> {
      if (durable) return withHeadlessStorage(pluginId, false, (values) => Object.keys(values))
      const result: string[] = []
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        if (k && k.startsWith(prefix)) {
          result.push(k.slice(prefix.length))
        }
      }
      return result
    },

    async delete(key: string): Promise<void> {
      await this.remove(key)
    },

    async clear(): Promise<void> {
      if (durable)
        return withHeadlessStorage(pluginId, true, (values) => {
          for (const key of Object.keys(values)) delete values[key]
        })
      const keysToRemove: string[] = []
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        if (k && k.startsWith(prefix)) {
          keysToRemove.push(k)
        }
      }
      for (const k of keysToRemove) {
        localStorage.removeItem(k)
      }
      logger.info(`Cleared all storage (${keysToRemove.length} entries)`)
    },

    async getUsage(): Promise<number> {
      if (durable)
        return withHeadlessStorage(pluginId, false, (values) =>
          Object.entries(values).reduce(
            (total, [key, value]) =>
              total + 2 * (getStorageKey(pluginId, key).length + value.length),
            0
          )
        )
      let totalBytes = 0
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        if (k && k.startsWith(prefix)) {
          const v = localStorage.getItem(k)
          totalBytes += k.length + (v?.length || 0)
        }
      }
      return totalBytes * 2 // UTF-16 encoding
    },

    async setSecure<T = unknown>(key: string, value: T): Promise<void> {
      try {
        // Per-install master key (W2.5): confidentiality no longer rests on
        // the public plugin id.
        const cryptoKey = await deriveInstallKey(pluginId)
        const serialized = JSON.stringify(value)
        const encrypted = await encrypt(serialized, cryptoKey)
        await this.set(key, `${ENCRYPTED_PREFIX}${encrypted}`)
      } catch (err) {
        logger.error(`Failed to write secure storage key: ${key}`, err)
        throw err
      }
    },

    async getSecure<T = unknown>(key: string): Promise<T | undefined> {
      try {
        const raw = await this.get<string>(key)
        if (raw === undefined) return undefined
        if (typeof raw !== "string" || !raw.startsWith(ENCRYPTED_PREFIX)) {
          logger.warn(`Storage key '${key}' is not encrypted, returning undefined`)
          return undefined
        }

        const encryptedData = raw.slice(ENCRYPTED_PREFIX.length)
        try {
          const cryptoKey = await deriveInstallKey(pluginId)
          const decrypted = await decrypt(encryptedData, cryptoKey)
          return JSON.parse(decrypted) as T
        } catch {
          // Pre-W2.5 value encrypted with the legacy public-id key: decrypt
          // with it once and transparently re-encrypt under the install key.
          const legacyKey = await deriveKey(pluginId)
          const decrypted = await decrypt(encryptedData, legacyKey)
          const value = JSON.parse(decrypted) as T
          await this.setSecure(key, value)
          logger.info(`Migrated secure storage key '${key}' to the per-install encryption key`)
          return value
        }
      } catch (err) {
        logger.error(`Failed to read secure storage key: ${key}`, err)
        return undefined
      }
    },

    async isEncrypted(key: string): Promise<boolean> {
      const raw = await this.get<string>(key)
      return typeof raw === "string" && raw.startsWith(ENCRYPTED_PREFIX)
    },
  }
}

/**
 * Clear all storage for a plugin (called during uninstall)
 */
export function clearPluginStorage(pluginId: string): void {
  const prefix = getPluginPrefix(pluginId)
  const keysToRemove: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (k && k.startsWith(prefix)) {
      keysToRemove.push(k)
    }
  }
  for (const k of keysToRemove) {
    localStorage.removeItem(k)
  }
}

/**
 * Get storage usage across all plugins
 */
export function getAllPluginStorageUsage(): Record<string, number> {
  const usage: Record<string, number> = {}
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (k && k.startsWith(STORAGE_PREFIX)) {
      const remainder = k.slice(STORAGE_PREFIX.length)
      const colonIndex = remainder.indexOf(":")
      if (colonIndex > 0) {
        const pluginId = remainder.slice(0, colonIndex)
        const v = localStorage.getItem(k)
        const bytes = (k.length + (v?.length || 0)) * 2
        usage[pluginId] = (usage[pluginId] || 0) + bytes
      }
    }
  }
  return usage
}
