/**
 * TTS Cache — IndexedDB-backed audio cache. Ported from Cognia's
 * `lib/ai/tts/tts-cache.ts`. Cuts redundant provider calls and survives a
 * page reload.
 *
 * Tunables: 24h TTL, 100 MB cap. Eviction on write removes expired entries
 * first, then oldest by createdAt until under the cap.
 */

import { getAdapter } from "./providers/registry"
import { getTTSError, type TTSProvider, type TTSResponse, type TTSSettings } from "./types"

const DB_NAME = "cognia-next-tts-cache"
const DB_VERSION = 1
const STORE_NAME = "audio-cache"
const CACHE_TTL = 24 * 60 * 60 * 1000
const MAX_CACHE_SIZE = 100 * 1024 * 1024

export interface TTSCacheEntry {
  key: string
  audioBlob: Blob
  mimeType: string
  createdAt: number
  expiresAt: number
  provider: TTSProvider
  text: string
  size: number
}

/**
 * Cache key derived from text + provider + provider-relevant settings. Two
 * calls with the same text but a different voice/model must NOT collide.
 */
export async function generateCacheKey(
  text: string,
  provider: TTSProvider,
  settings: Partial<TTSSettings>
): Promise<string> {
  const params = {
    text,
    provider,
    pronunciationDict: settings.ttsPronunciationDictionary,
    ...(getAdapter(provider)?.cacheKeyFields(settings) ?? {}),
  }
  return hashString(JSON.stringify(params))
}

/**
 * SHA-256 → hex. The previous 31-bit djb2 hash birthday-collided at ~65k
 * entries (well within the 100 MB cap), which returns *wrong* audio for a
 * different input rather than a miss. The `tts2_` prefix invalidates the old
 * `tts_` keys cleanly — legacy entries are never re-read and expire via TTL.
 */
async function hashString(str: string): Promise<string> {
  const data = new TextEncoder().encode(str)
  const digest = await crypto.subtle.digest("SHA-256", data)
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
  return `tts2_${hex}`
}

class TTSCacheManager {
  private db: IDBDatabase | null = null
  private initPromise: Promise<void> | null = null

  async init(): Promise<void> {
    if (this.db) return
    if (this.initPromise) return this.initPromise

    this.initPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(new Error("IndexedDB not available"))
        return
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onerror = () => reject(new Error("Failed to open TTS cache database"))
      req.onsuccess = () => {
        this.db = req.result
        resolve()
      }
      req.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: "key" })
          store.createIndex("expiresAt", "expiresAt", { unique: false })
          store.createIndex("createdAt", "createdAt", { unique: false })
          store.createIndex("provider", "provider", { unique: false })
        }
      }
    })
    return this.initPromise
  }

  async get(key: string): Promise<TTSCacheEntry | null> {
    await this.init()
    if (!this.db) return null
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORE_NAME, "readonly")
      const req = tx.objectStore(STORE_NAME).get(key)
      req.onerror = () => reject(new Error("Failed to get cached audio"))
      req.onsuccess = () => {
        const entry = req.result as TTSCacheEntry | undefined
        if (entry && entry.expiresAt < Date.now()) {
          void this.delete(key).catch(() => {})
          resolve(null)
        } else {
          resolve(entry ?? null)
        }
      }
    })
  }

  async set(
    key: string,
    audioBlob: Blob,
    mimeType: string,
    provider: TTSProvider,
    text: string
  ): Promise<void> {
    await this.init()
    if (!this.db) return
    const now = Date.now()
    const entry: TTSCacheEntry = {
      key,
      audioBlob,
      mimeType,
      createdAt: now,
      expiresAt: now + CACHE_TTL,
      provider,
      text: text.substring(0, 100),
      size: audioBlob.size,
    }
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORE_NAME, "readwrite")
      const req = tx.objectStore(STORE_NAME).put(entry)
      req.onerror = () => reject(new Error("Failed to cache audio"))
      req.onsuccess = () => {
        void this.cleanupIfNeeded().catch(() => {})
        resolve()
      }
    })
  }

  async delete(key: string): Promise<void> {
    await this.init()
    if (!this.db) return
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORE_NAME, "readwrite")
      const req = tx.objectStore(STORE_NAME).delete(key)
      req.onerror = () => reject(new Error("Failed to delete cached audio"))
      req.onsuccess = () => resolve()
    })
  }

  async clear(): Promise<void> {
    await this.init()
    if (!this.db) return
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORE_NAME, "readwrite")
      const req = tx.objectStore(STORE_NAME).clear()
      req.onerror = () => reject(new Error("Failed to clear cache"))
      req.onsuccess = () => resolve()
    })
  }

  async getCacheSize(): Promise<number> {
    await this.init()
    if (!this.db) return 0
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORE_NAME, "readonly")
      const req = tx.objectStore(STORE_NAME).getAll()
      req.onerror = () => reject(new Error("Failed to get cache size"))
      req.onsuccess = () => {
        const entries = req.result as TTSCacheEntry[]
        resolve(entries.reduce((acc, e) => acc + e.size, 0))
      }
    })
  }

  async getStats(): Promise<{
    totalSize: number
    entryCount: number
    providers: Partial<Record<TTSProvider, number>>
  }> {
    await this.init()
    if (!this.db) return { totalSize: 0, entryCount: 0, providers: {} }
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORE_NAME, "readonly")
      const req = tx.objectStore(STORE_NAME).getAll()
      req.onerror = () => reject(new Error("Failed to get cache stats"))
      req.onsuccess = () => {
        const entries = req.result as TTSCacheEntry[]
        const providers: Partial<Record<TTSProvider, number>> = {}
        let total = 0
        for (const e of entries) {
          total += e.size
          providers[e.provider] = (providers[e.provider] ?? 0) + 1
        }
        resolve({ totalSize: total, entryCount: entries.length, providers })
      }
    })
  }

  async cleanupIfNeeded(): Promise<void> {
    await this.init()
    if (!this.db) return
    const now = Date.now()
    await new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction(STORE_NAME, "readwrite")
      const idx = tx.objectStore(STORE_NAME).index("expiresAt")
      const req = idx.openCursor(IDBKeyRange.upperBound(now))
      req.onerror = () => reject(new Error("Failed to cleanup expired entries"))
      req.onsuccess = () => {
        const cur = req.result
        if (cur) {
          cur.delete()
          cur.continue()
        } else resolve()
      }
    })
    const totalSize = await this.getCacheSize()
    if (totalSize > MAX_CACHE_SIZE) {
      await this.removeOldestEntries(totalSize - MAX_CACHE_SIZE)
    }
  }

  private async removeOldestEntries(bytesToFree: number): Promise<void> {
    await this.init()
    if (!this.db) return
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORE_NAME, "readwrite")
      const idx = tx.objectStore(STORE_NAME).index("createdAt")
      const req = idx.openCursor()
      let freed = 0
      req.onerror = () => reject(new Error("Failed to remove oldest entries"))
      req.onsuccess = () => {
        const cur = req.result
        if (cur && freed < bytesToFree) {
          freed += (cur.value as TTSCacheEntry).size
          cur.delete()
          cur.continue()
        } else resolve()
      }
    })
  }
}

export const ttsCache = new TTSCacheManager()

export async function getCachedOrGenerate(
  key: string,
  generateFn: () => Promise<{
    audioData: ArrayBuffer | Blob
    mimeType: string
  } | null>,
  provider: TTSProvider,
  text: string,
  cacheEnabled = true
): Promise<{ audioData: ArrayBuffer | Blob; mimeType: string } | null> {
  if (cacheEnabled) {
    try {
      const cached = await ttsCache.get(key)
      if (cached) {
        return { audioData: cached.audioBlob, mimeType: cached.mimeType }
      }
    } catch {
      /* ignore — falls through to generate */
    }
  }
  const result = await generateFn()
  if (!result) return null
  if (cacheEnabled) {
    try {
      const blob =
        result.audioData instanceof Blob
          ? result.audioData
          : new Blob([result.audioData], { type: result.mimeType })
      await ttsCache.set(key, blob, result.mimeType, provider, text)
    } catch {
      /* ignore — best-effort cache */
    }
  }
  return result
}

/** Cache seam that preserves a provider's structured failure response. */
export async function getCachedTtsResponseOrGenerate(
  key: string,
  generateFn: () => Promise<TTSResponse>,
  provider: TTSProvider,
  text: string,
  cacheEnabled = true,
  signal?: AbortSignal
): Promise<TTSResponse> {
  if (signal?.aborted) return cancelledResponse()
  if (cacheEnabled) {
    try {
      const cached = await ttsCache.get(key)
      if (signal?.aborted) return cancelledResponse()
      if (cached) {
        return { success: true, audioData: cached.audioBlob, mimeType: cached.mimeType }
      }
    } catch {
      // Cache failures must never prevent synthesis.
    }
  }

  const response = await generateFn()
  if (signal?.aborted) return cancelledResponse()
  if (!response.success || !response.audioData) return response
  if (cacheEnabled) {
    try {
      const mimeType = response.mimeType ?? "audio/mpeg"
      const blob =
        response.audioData instanceof Blob
          ? response.audioData
          : new Blob([response.audioData], { type: mimeType })
      await ttsCache.set(key, blob, mimeType, provider, text)
    } catch {
      // Best-effort cache; preserve the successful provider response.
    }
  }
  return response
}

function cancelledResponse(): TTSResponse {
  return {
    success: false,
    error: getTTSError("cancelled").message,
    errorType: "cancelled",
  }
}
