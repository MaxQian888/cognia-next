/** @jest-environment jsdom */
/**
 * Tests for the IndexedDB-backed TTS audio cache. Drives the real cache
 * manager against fake-indexeddb so we exercise the same code paths as
 * production (no mocking the manager itself).
 */

import "fake-indexeddb/auto"
import {
  generateCacheKey,
  getCachedOrGenerate,
  getCachedTtsResponseOrGenerate,
  ttsCache,
} from "./tts-cache"
import type { TTSSettings } from "./types"

beforeEach(async () => {
  // Close any existing connection then clear via the cache manager (which
  // uses the same db handle, so we don't deadlock on `deleteDatabase`).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = (ttsCache as any).db as IDBDatabase | null
  if (db) {
    await ttsCache.clear()
  }
})

describe("generateCacheKey", () => {
  it("yields the same key for identical params", async () => {
    const s: Partial<TTSSettings> = { openaiVoice: "alloy", openaiModel: "tts-1" }
    expect(await generateCacheKey("hello", "openai", s)).toBe(
      await generateCacheKey("hello", "openai", s)
    )
  })

  it("changes when text or provider changes", async () => {
    const s: Partial<TTSSettings> = { openaiVoice: "alloy" }
    const k1 = await generateCacheKey("hello", "openai", s)
    const k2 = await generateCacheKey("hello!", "openai", s)
    const k3 = await generateCacheKey("hello", "elevenlabs", { elevenlabsVoice: "rachel" })
    expect(k1).not.toBe(k2)
    expect(k1).not.toBe(k3)
  })

  it("changes when a provider-specific setting differs", async () => {
    const a = await generateCacheKey("hi", "openai", { openaiVoice: "alloy" })
    const b = await generateCacheKey("hi", "openai", { openaiVoice: "nova" })
    expect(a).not.toBe(b)
  })

  it("uses a SHA-256 hex digest under the tts2_ version prefix", async () => {
    // Regression pin for the collision fix (W5): keys must be the 64-hex-char
    // SHA-256 form, not the old 31-bit djb2 base36, and carry the tts2_ prefix
    // so legacy tts_ entries are never re-read.
    const k = await generateCacheKey("hello", "openai", { openaiVoice: "alloy" })
    expect(k).toMatch(/^tts2_[0-9a-f]{64}$/)
  })

  it("derives provider-specific keys for every provider", async () => {
    const text = "x"
    const settings: Partial<TTSSettings> = {
      openaiVoice: "alloy",
      geminiVoice: "Kore",
      edgeVoice: "en-US-JennyNeural",
      elevenlabsVoice: "rachel",
      lmntVoice: "lily",
      humeVoice: "kora",
      cartesiaVoice: "a0e99841-438c-4a64-b679-ae501e7d6091",
      deepgramVoice: "aura-2-asteria-en",
    }
    const ids: Array<Parameters<typeof generateCacheKey>[1]> = [
      "system",
      "openai",
      "gemini",
      "edge",
      "elevenlabs",
      "lmnt",
      "hume",
      "cartesia",
      "deepgram",
    ]
    const keys = await Promise.all(ids.map((p) => generateCacheKey(text, p, settings)))
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys.every((k) => k.startsWith("tts2_"))).toBe(true)
  })
})

describe("ttsCache CRUD", () => {
  it("set/get round-trip", async () => {
    const blob = new Blob(["hello"], { type: "audio/mpeg" })
    await ttsCache.set("k1", blob, "audio/mpeg", "openai", "hello")
    const e = await ttsCache.get("k1")
    expect(e).not.toBeNull()
    expect(e!.size).toBe(blob.size)
    expect(e!.provider).toBe("openai")
    expect(e!.mimeType).toBe("audio/mpeg")
  })

  it("get returns null for missing keys", async () => {
    expect(await ttsCache.get("nope")).toBeNull()
  })

  it("get evicts and returns null for expired entries", async () => {
    const blob = new Blob(["hi"], { type: "audio/mpeg" })
    await ttsCache.set("expire", blob, "audio/mpeg", "openai", "hi")
    // Force expiry by writing the row again with expiresAt in the past.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db: IDBDatabase = (ttsCache as any).db
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("audio-cache", "readwrite")
      const store = tx.objectStore("audio-cache")
      const req = store.get("expire")
      req.onsuccess = () => {
        const row = req.result
        row.expiresAt = Date.now() - 1
        const put = store.put(row)
        put.onsuccess = () => resolve()
        put.onerror = () => reject(put.error)
      }
      req.onerror = () => reject(req.error)
    })
    expect(await ttsCache.get("expire")).toBeNull()
  })

  it("delete removes a row", async () => {
    await ttsCache.set("del-key", new Blob(["x"]), "audio/mpeg", "openai", "x")
    await ttsCache.delete("del-key")
    expect(await ttsCache.get("del-key")).toBeNull()
  })

  it("clear empties the store", async () => {
    await ttsCache.set("clear-key", new Blob(["x"]), "audio/mpeg", "openai", "x")
    await ttsCache.clear()
    expect(await ttsCache.getCacheSize()).toBe(0)
  })

  it("getCacheSize sums entry sizes", async () => {
    await ttsCache.set("sz-a", new Blob(["xx"]), "audio/mpeg", "openai", "a")
    await ttsCache.set("sz-b", new Blob(["yyy"]), "audio/mpeg", "openai", "b")
    expect(await ttsCache.getCacheSize()).toBe(5)
  })

  it("getStats counts entries per provider", async () => {
    await ttsCache.set("stats-a", new Blob(["x"]), "audio/mpeg", "openai", "a")
    await ttsCache.set("stats-b", new Blob(["y"]), "audio/mpeg", "elevenlabs", "b")
    const s = await ttsCache.getStats()
    expect(s.entryCount).toBe(2)
    expect(s.providers.openai).toBe(1)
    expect(s.providers.elevenlabs).toBe(1)
    expect(s.totalSize).toBe(2)
  })

  it("cleanupIfNeeded purges expired rows", async () => {
    await ttsCache.set("cu-good", new Blob(["x"]), "audio/mpeg", "openai", "g")
    await ttsCache.set("cu-old", new Blob(["x"]), "audio/mpeg", "openai", "o")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db: IDBDatabase = (ttsCache as any).db
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("audio-cache", "readwrite")
      const store = tx.objectStore("audio-cache")
      const req = store.get("cu-old")
      req.onsuccess = () => {
        const row = req.result
        row.expiresAt = Date.now() - 1000
        const put = store.put(row)
        put.onsuccess = () => resolve()
        put.onerror = () => reject(put.error)
      }
      req.onerror = () => reject(req.error)
    })
    await ttsCache.cleanupIfNeeded()
    expect(await ttsCache.get("cu-old")).toBeNull()
    expect(await ttsCache.get("cu-good")).not.toBeNull()
  })

  it("cleanupIfNeeded evicts oldest by createdAt when over the cap", async () => {
    const big = new Uint8Array(1024)
    big.fill(0xa1)
    await ttsCache.set("oldest", new Blob([big]), "audio/mpeg", "openai", "o")
    await new Promise((r) => setTimeout(r, 5))
    await ttsCache.set("newer", new Blob([big]), "audio/mpeg", "openai", "n")

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (ttsCache as any).removeOldestEntries(1024)
    expect(await ttsCache.get("oldest")).toBeNull()
    expect(await ttsCache.get("newer")).not.toBeNull()
  })
})

describe("getCachedOrGenerate", () => {
  it("returns cached audio without calling the generator", async () => {
    await ttsCache.set("hit", new Blob(["abc"]), "audio/mpeg", "openai", "abc")
    const gen = jest.fn()
    const r = await getCachedOrGenerate("hit", gen, "openai", "abc")
    expect(gen).not.toHaveBeenCalled()
    expect(r).not.toBeNull()
    expect(r!.mimeType).toBe("audio/mpeg")
  })

  it("calls the generator on miss and caches the result", async () => {
    const data = new ArrayBuffer(8)
    const gen = jest.fn().mockResolvedValue({ audioData: data, mimeType: "audio/mpeg" })
    const r = await getCachedOrGenerate("miss", gen, "openai", "x")
    expect(gen).toHaveBeenCalledTimes(1)
    expect(r).toEqual({ audioData: data, mimeType: "audio/mpeg" })
    // second call hits the cache
    const r2 = await getCachedOrGenerate("miss", gen, "openai", "x")
    expect(gen).toHaveBeenCalledTimes(1)
    expect(r2).not.toBeNull()
  })

  it("forwards Blob results unchanged", async () => {
    const blob = new Blob(["yo"], { type: "audio/wav" })
    const gen = jest.fn().mockResolvedValue({ audioData: blob, mimeType: "audio/wav" })
    const r = await getCachedOrGenerate("blob", gen, "openai", "yo")
    expect(r).not.toBeNull()
    expect(r!.audioData).toBe(blob)
  })

  it("returns null when the generator returns null", async () => {
    const gen = jest.fn().mockResolvedValue(null)
    expect(await getCachedOrGenerate("none", gen, "openai", "x")).toBeNull()
  })

  it("does not consult cache when cacheEnabled=false", async () => {
    await ttsCache.set("disabled", new Blob(["abc"]), "audio/mpeg", "openai", "abc")
    const gen = jest
      .fn()
      .mockResolvedValue({ audioData: new ArrayBuffer(2), mimeType: "audio/mpeg" })
    await getCachedOrGenerate("disabled", gen, "openai", "abc", false)
    expect(gen).toHaveBeenCalledTimes(1)
  })

  it("falls through to generation if the cache get throws", async () => {
    const spy = jest.spyOn(ttsCache, "get").mockRejectedValueOnce(new Error("nope"))
    const data = new ArrayBuffer(2)
    const gen = jest.fn().mockResolvedValue({ audioData: data, mimeType: "audio/mpeg" })
    const r = await getCachedOrGenerate("err", gen, "openai", "x")
    expect(r).not.toBeNull()
    expect(gen).toHaveBeenCalled()
    spy.mockRestore()
  })

  it("ignores best-effort cache writes that fail", async () => {
    const spy = jest.spyOn(ttsCache, "set").mockRejectedValueOnce(new Error("boom"))
    const data = new ArrayBuffer(1)
    const gen = jest.fn().mockResolvedValue({ audioData: data, mimeType: "audio/mpeg" })
    const r = await getCachedOrGenerate("setfail", gen, "openai", "x")
    expect(r).not.toBeNull()
    spy.mockRestore()
  })
})

describe("getCachedTtsResponseOrGenerate", () => {
  it("preserves the provider's structured failure and never caches it", async () => {
    const setSpy = jest.spyOn(ttsCache, "set")
    const failure = {
      success: false,
      error: "TTS API returned an error",
      errorType: "api-error" as const,
      status: 401,
      providerMessage: "invalid key",
    }
    const result = await getCachedTtsResponseOrGenerate(
      "structured-failure",
      async () => failure,
      "openai",
      "hello"
    )
    expect(result).toEqual(failure)
    expect(setSpy).not.toHaveBeenCalled()
    setSpy.mockRestore()
  })

  it("discards a successful response cancelled before the cache write", async () => {
    const controller = new AbortController()
    const setSpy = jest.spyOn(ttsCache, "set")
    const result = await getCachedTtsResponseOrGenerate(
      "cancelled-success",
      async () => {
        controller.abort()
        return {
          success: true,
          audioData: new ArrayBuffer(2),
          mimeType: "audio/mpeg",
        }
      },
      "openai",
      "hello",
      true,
      controller.signal
    )

    expect(result).toMatchObject({ success: false, errorType: "cancelled" })
    expect(setSpy).not.toHaveBeenCalled()
    setSpy.mockRestore()
  })
})
