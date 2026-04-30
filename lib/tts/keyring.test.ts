/**
 * Tests for the TTS keyring frontend wrapper. Drives both code paths:
 *   - Tauri (mocks `@tauri-apps/api/core` and `lib/tauri.isTauri`)
 *   - Web fallback (uses fake-indexeddb-backed Dexie)
 */

import "fake-indexeddb/auto"

jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(),
}))

import { isTauri } from "@/lib/tauri"
import * as core from "@tauri-apps/api/core"
import {
  KEYRING_PROVIDER_IDS,
  clearProviderKey,
  getProviderKey,
  isProviderKeyMissing,
  keyringProviderFor,
  loadAllProviderKeys,
  providerKeyMapToSettingsMap,
  setProviderKey,
} from "./keyring"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"

const mockIsTauri = isTauri as jest.Mock
const mockInvoke = core.invoke as unknown as jest.Mock

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  mockIsTauri.mockReset()
  mockInvoke.mockReset()
})

describe("keyringProviderFor", () => {
  it("maps every keyed TTSProvider", () => {
    expect(keyringProviderFor("openai")).toBe("openai")
    expect(keyringProviderFor("gemini")).toBe("google")
    expect(keyringProviderFor("elevenlabs")).toBe("elevenlabs")
    expect(keyringProviderFor("lmnt")).toBe("lmnt")
    expect(keyringProviderFor("hume")).toBe("hume")
    expect(keyringProviderFor("cartesia")).toBe("cartesia")
    expect(keyringProviderFor("deepgram")).toBe("deepgram")
  })

  it("returns null for free providers", () => {
    expect(keyringProviderFor("system")).toBeNull()
    expect(keyringProviderFor("edge")).toBeNull()
  })
})

describe("KEYRING_PROVIDER_IDS", () => {
  it("matches the seven non-system, non-edge providers", () => {
    expect(KEYRING_PROVIDER_IDS).toHaveLength(7)
    expect(new Set(KEYRING_PROVIDER_IDS).size).toBe(7)
  })
})

describe("getProviderKey/setProviderKey/clearProviderKey (web fallback)", () => {
  beforeEach(() => mockIsTauri.mockReturnValue(false))

  it("returns null when no key has been set", async () => {
    expect(await getProviderKey("openai")).toBeNull()
  })

  it("round-trips a value via Dexie", async () => {
    await setProviderKey("openai", "sk-abc")
    expect(await getProviderKey("openai")).toBe("sk-abc")
  })

  it("trims surrounding whitespace before storing", async () => {
    await setProviderKey("openai", "  sk-trim  ")
    expect(await getProviderKey("openai")).toBe("sk-trim")
  })

  it("setting an empty/whitespace value deletes the row", async () => {
    await setProviderKey("openai", "sk-1")
    await setProviderKey("openai", "   ")
    expect(await getProviderKey("openai")).toBeNull()
  })

  it("clearProviderKey removes an existing row", async () => {
    await setProviderKey("hume", "h-key")
    await clearProviderKey("hume")
    expect(await getProviderKey("hume")).toBeNull()
  })
})

describe("getProviderKey/setProviderKey/clearProviderKey (Tauri)", () => {
  beforeEach(() => mockIsTauri.mockReturnValue(true))

  it("delegates get to tts_keyring_get and unwraps null", async () => {
    mockInvoke.mockResolvedValueOnce("sk-from-keyring")
    expect(await getProviderKey("openai")).toBe("sk-from-keyring")
    expect(mockInvoke).toHaveBeenCalledWith("tts_keyring_get", { provider: "openai" })
  })

  it("returns null when the keyring returns an empty string", async () => {
    mockInvoke.mockResolvedValueOnce("")
    expect(await getProviderKey("openai")).toBeNull()
  })

  it("returns null when the keyring returns null", async () => {
    mockInvoke.mockResolvedValueOnce(null)
    expect(await getProviderKey("openai")).toBeNull()
  })

  it("setProviderKey with empty string calls delete", async () => {
    mockInvoke.mockResolvedValueOnce(undefined)
    await setProviderKey("hume", "   ")
    expect(mockInvoke).toHaveBeenCalledWith("tts_keyring_delete", { provider: "hume" })
  })

  it("setProviderKey with a real value calls set", async () => {
    mockInvoke.mockResolvedValueOnce(undefined)
    await setProviderKey("hume", "h-key")
    expect(mockInvoke).toHaveBeenCalledWith("tts_keyring_set", {
      provider: "hume",
      key: "h-key",
    })
  })

  it("clearProviderKey calls delete", async () => {
    mockInvoke.mockResolvedValueOnce(undefined)
    await clearProviderKey("openai")
    expect(mockInvoke).toHaveBeenCalledWith("tts_keyring_delete", { provider: "openai" })
  })
})

describe("loadAllProviderKeys", () => {
  it("aggregates web-fallback rows", async () => {
    mockIsTauri.mockReturnValue(false)
    await setProviderKey("openai", "k1")
    await setProviderKey("hume", "k2")
    const map = await loadAllProviderKeys()
    expect(map).toEqual({ openai: "k1", hume: "k2" })
  })

  it("queries Tauri keyring for every listed provider and skips empty values", async () => {
    mockIsTauri.mockReturnValue(true)
    // first call: list providers
    mockInvoke.mockImplementationOnce(async () => ["openai", "hume"])
    // subsequent calls: getProviderKey -> tts_keyring_get
    mockInvoke.mockImplementationOnce(async () => "key-1") // openai
    mockInvoke.mockImplementationOnce(async () => "") // hume — empty -> dropped

    const map = await loadAllProviderKeys()
    expect(map).toEqual({ openai: "key-1" })
    expect(mockInvoke).toHaveBeenCalledWith("tts_keyring_list_providers")
  })
})

describe("providerKeyMapToSettingsMap", () => {
  it("only emits entries for providers with values", () => {
    const out = providerKeyMapToSettingsMap({ openai: "k1", hume: "k2" })
    expect(out).toEqual({ openai: { apiKey: "k1" }, hume: { apiKey: "k2" } })
  })

  it("ignores undefined providers", () => {
    expect(providerKeyMapToSettingsMap({})).toEqual({})
  })
})

describe("isProviderKeyMissing", () => {
  it("returns false for providers that don't need a key", () => {
    expect(isProviderKeyMissing("system", {})).toBe(false)
    expect(isProviderKeyMissing("edge", {})).toBe(false)
  })

  it("returns true when the key is missing for a paid provider", () => {
    expect(isProviderKeyMissing("openai", {})).toBe(true)
    expect(isProviderKeyMissing("gemini", {})).toBe(true)
  })

  it("returns false when the key is present", () => {
    expect(isProviderKeyMissing("openai", { openai: "k" })).toBe(false)
    expect(isProviderKeyMissing("gemini", { google: "k" })).toBe(false)
  })
})
