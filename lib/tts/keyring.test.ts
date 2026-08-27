/** @jest-environment jsdom */
/**
 * Tests for the TTS keyring frontend wrapper. Drives both code paths:
 *   - Tauri (mocks `@tauri-apps/api/core` and `lib/tauri.isTauri`)
 *   - Web fallback (Browser Vault/session store plus legacy Dexie migration)
 */

import "fake-indexeddb/auto"

jest.mock("@/lib/tauri", () => ({
  ...jest.requireActual("@/lib/tauri"),
  isTauri: jest.fn(),
}))

import { isTauri } from "@/lib/tauri"
import * as core from "@tauri-apps/api/core"
import {
  HOST_KEY_PRESENT,
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
    expect(keyringProviderFor("mistral")).toBe("mistral")
    expect(keyringProviderFor("local-openai-compatible")).toBe("local-openai-compatible")
  })

  it("returns null for free providers", () => {
    expect(keyringProviderFor("system")).toBeNull()
    expect(keyringProviderFor("edge")).toBeNull()
    expect(keyringProviderFor("openai-realtime")).toBeNull()
  })
})

describe("KEYRING_PROVIDER_IDS", () => {
  it("lists every keyring account exactly once", () => {
    expect(KEYRING_PROVIDER_IDS).toHaveLength(14)
    expect(new Set(KEYRING_PROVIDER_IDS).size).toBe(14)
  })

  it("carries xai, which is a live-voice account with no TTS provider", () => {
    // The keyring backs both subsystems, so its account list is a superset of
    // the TTS providers: `keyringProviderFor` never returns xai, but live voice
    // still needs somewhere to store the key.
    expect(KEYRING_PROVIDER_IDS).toContain("xai")
    expect(KEYRING_PROVIDER_IDS).toEqual(expect.arrayContaining(["qwen", "doubao", "baidu"]))
  })
})

describe("getProviderKey/setProviderKey/clearProviderKey (web fallback)", () => {
  beforeEach(() => mockIsTauri.mockReturnValue(false))

  it("returns null when no key has been set", async () => {
    expect(await getProviderKey("openai")).toBeNull()
  })

  it("round-trips a value without persisting cleartext in Dexie", async () => {
    await setProviderKey("openai", "sk-abc")
    expect(await getProviderKey("openai")).toBe("sk-abc")
    expect(await getDb().tts_provider_keys.get("tts.providerKey.openai")).toBeUndefined()
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

  it("loads only Tauri key presence and never requests secret values", async () => {
    mockIsTauri.mockReturnValue(true)
    // first call: list providers
    mockInvoke.mockImplementationOnce(async () => ["openai", "hume"])
    const map = await loadAllProviderKeys()
    expect(map).toEqual({ openai: HOST_KEY_PRESENT, hume: HOST_KEY_PRESENT })
    expect(mockInvoke).toHaveBeenCalledWith("tts_keyring_list_providers")
    expect(mockInvoke).not.toHaveBeenCalledWith("tts_keyring_get", expect.anything())
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

  it("turns a desktop presence marker into a non-secret host placeholder", () => {
    expect(providerKeyMapToSettingsMap({ openai: HOST_KEY_PRESENT })).toEqual({
      openai: { apiKey: "host-key" },
    })
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
