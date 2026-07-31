/** @jest-environment node */

import {
  decryptEvalArtifact,
  encryptEvalArtifact,
  loadOrCreateEvalArtifactKey,
  loadOrCreateDesktopEvalKey,
} from "./artifact-crypto"
import type { KeyringStore } from "@/lib/credentials/keyring-store"

describe("evaluation artifact encryption", () => {
  it("round-trips authenticated JSON and rejects tampering", async () => {
    const rawKey = crypto.getRandomValues(new Uint8Array(32))
    const envelope = await encryptEvalArtifact(rawKey, { prompt: "private", score: 0.9 })

    await expect(decryptEvalArtifact(rawKey, envelope)).resolves.toEqual({
      prompt: "private",
      score: 0.9,
    })

    const tampered = { ...envelope, ciphertext: `${envelope.ciphertext.slice(0, -2)}AA` }
    await expect(decryptEvalArtifact(rawKey, tampered)).rejects.toThrow()
  })

  it("keeps one account-scoped random desktop key in the injected keyring", async () => {
    const values = new Map<string, string>()
    const store: KeyringStore = {
      save: jest.fn(async (key, value) => void values.set(key, value)),
      load: jest.fn(async (key) => values.get(key) ?? null),
      delete: jest.fn(async (key) => void values.delete(key)),
    }

    const first = await loadOrCreateDesktopEvalKey("account-a", store)
    const second = await loadOrCreateDesktopEvalKey("account-a", store)
    const other = await loadOrCreateDesktopEvalKey("account-b", store)

    expect(second).toEqual(first)
    expect(other).not.toEqual(first)
    expect(store.save).toHaveBeenCalledTimes(2)
  })

  it("stores the web data key inside the unlocked browser vault", async () => {
    const vault = {
      accountId: "account-web",
      loadSecret: jest.fn<Promise<string | null>, [string]>().mockResolvedValue(null),
      storeSecret: jest.fn<Promise<void>, [string, string]>().mockResolvedValue(),
    }

    const key = await loadOrCreateEvalArtifactKey("account-web", {
      platform: "web",
      getBrowserVault: () => vault,
    })

    expect(key).toHaveLength(32)
    expect(vault.loadSecret).toHaveBeenCalledWith("evaluation-artifact-data-key")
    expect(vault.storeSecret).toHaveBeenCalledWith(
      "evaluation-artifact-data-key",
      expect.any(String)
    )
  })

  it("refuses web artifact access while the account vault is locked", async () => {
    await expect(
      loadOrCreateEvalArtifactKey("account-web", {
        platform: "web",
        getBrowserVault: () => null,
      })
    ).rejects.toThrow("unlocked account vault")
  })
})
