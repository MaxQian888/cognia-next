/**
 * Plugin Storage API Implementation
 *
 * Provides per-plugin persistent key-value storage backed by localStorage.
 * Each plugin gets an isolated namespace to prevent conflicts.
 */

import { createPluginSystemLogger } from "../core/logger"
import { deriveKey, encrypt, decrypt } from "./crypto-helpers"

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

/**
 * Create the Storage API for a plugin
 */
export function createStorageAPI(pluginId: string): PluginStorageAPI {
  const logger = createPluginSystemLogger(pluginId)
  const prefix = getPluginPrefix(pluginId)

  return {
    async get<T = unknown>(key: string): Promise<T | undefined> {
      try {
        const raw = localStorage.getItem(getStorageKey(pluginId, key))
        if (raw === null) return undefined
        return JSON.parse(raw) as T
      } catch {
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
        if (err instanceof Error && err.message.includes("storage limit")) {
          throw err
        }
        logger.error(`Failed to write storage key: ${key}`, err)
      }
    },

    async remove(key: string): Promise<void> {
      localStorage.removeItem(getStorageKey(pluginId, key))
    },

    async has(key: string): Promise<boolean> {
      return localStorage.getItem(getStorageKey(pluginId, key)) !== null
    },

    async keys(): Promise<string[]> {
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
        const cryptoKey = await deriveKey(pluginId)
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

        const cryptoKey = await deriveKey(pluginId)
        const encryptedData = raw.slice(ENCRYPTED_PREFIX.length)
        const decrypted = await decrypt(encryptedData, cryptoKey)
        return JSON.parse(decrypted) as T
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
