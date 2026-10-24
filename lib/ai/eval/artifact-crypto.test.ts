/** @jest-environment node */

import "fake-indexeddb/auto"
import Dexie from "dexie"
import {
  BROWSER_VAULT_DB_NAME,
  __resetBrowserVaultForTesting,
  __setBrowserVaultArgon2ParametersForTesting,
  provisionBrowserVault,
} from "@/lib/runtime/browser-vault"

import {
  decryptAccountArtifactBytes,
  decryptEvalArtifact,
  encryptEvalArtifact,
  loadOrCreateEvalArtifactKey,
  loadOrCreateDesktopEvalKey,
  encryptAccountArtifactBytes,
  loadOrCreateAccountArtifactKey,
} from "./artifact-crypto"
import type { KeyringStore } from "@/lib/credentials/keyring-store"
import {
  clearPartitionArtifactKeyBase,
  derivePartitionArtifactKey,
  installPartitionArtifactKeyBase,
} from "@/lib/accounts/partition-artifact-keys"

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
      localAccountId: "account-web",
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

  it("provides domain-separated binary AES-GCM with caller-bound AAD", async () => {
    const rawKey = crypto.getRandomValues(new Uint8Array(32))
    const aad = new TextEncoder().encode("performance|account-a|target-a|capture-a|0|frames")
    const envelope = await encryptAccountArtifactBytes(
      rawKey,
      new TextEncoder().encode("sensitive"),
      aad
    )
    await expect(decryptAccountArtifactBytes(rawKey, envelope, aad)).resolves.toEqual(
      new TextEncoder().encode("sensitive")
    )
    await expect(
      decryptAccountArtifactBytes(rawKey, envelope, new TextEncoder().encode("wrong-capture"))
    ).rejects.toThrow()
  })

  it("uses a separate account-scoped performance domain key without changing eval v1", async () => {
    const vault = {
      localAccountId: "account-web",
      loadSecret: jest.fn<Promise<string | null>, [string]>().mockResolvedValue(null),
      storeSecret: jest.fn<Promise<void>, [string, string]>().mockResolvedValue(),
    }
    await loadOrCreateAccountArtifactKey("account-web", "performance", {
      platform: "web",
      getBrowserVault: () => vault,
    })
    expect(vault.loadSecret).toHaveBeenCalledWith("performance-artifact-data-key")
  })

  it("keeps Human Input values under a dedicated account-scoped domain key", async () => {
    const vault = {
      localAccountId: "account-web",
      loadSecret: jest.fn<Promise<string | null>, [string]>().mockResolvedValue(null),
      storeSecret: jest.fn<Promise<void>, [string, string]>().mockResolvedValue(),
    }
    await loadOrCreateAccountArtifactKey("account-web", "human-input", {
      platform: "web",
      getBrowserVault: () => vault,
    })
    expect(vault.loadSecret).toHaveBeenCalledWith("human-input-artifact-data-key")
  })
})

it.each(["workflow-knowledge", "workflow-feedback", "workflow-annotation"] as const)(
  "retains a separate %s key per account on desktop and web",
  async (domain) => {
    const values = new Map<string, string>()
    const store: KeyringStore = {
      save: jest.fn(async (key, value) => void values.set(key, value)),
      load: jest.fn(async (key) => values.get(key) ?? null),
      delete: jest.fn(async (key) => void values.delete(key)),
    }
    const deps = { platform: "desktop" as const, keyringStore: store }
    const key = await loadOrCreateAccountArtifactKey("account-a", domain, deps)
    expect(await loadOrCreateAccountArtifactKey("account-a", domain, deps)).toEqual(key)
    expect(store.save).toHaveBeenCalledWith(
      `account:account-a:${domain}-data-key`,
      expect.any(String)
    )
    expect(await loadOrCreateAccountArtifactKey("account-b", domain, deps)).not.toEqual(key)

    const vault = {
      localAccountId: "account-web",
      loadSecret: jest.fn(async (_name: string): Promise<string | null> => null),
      storeSecret: jest.fn(async (_name: string, _value: string): Promise<void> => {}),
    }
    await loadOrCreateAccountArtifactKey("account-web", domain, {
      platform: "web",
      getBrowserVault: () => vault,
    })
    expect(vault.storeSecret).toHaveBeenCalledWith(
      `${domain}-artifact-data-key`,
      expect.any(String)
    )
  }
)

it("uses the real active vault through the default artifact-key provider", async () => {
  __resetBrowserVaultForTesting()
  __setBrowserVaultArgon2ParametersForTesting(32)
  await Dexie.delete(BROWSER_VAULT_DB_NAME)
  try {
    await provisionBrowserVault("acct_artifact_default", "password")
    const evalKey = await loadOrCreateEvalArtifactKey("acct_artifact_default", { platform: "web" })
    const performanceKey = await loadOrCreateAccountArtifactKey(
      "acct_artifact_default",
      "performance",
      { platform: "web" }
    )
    expect(evalKey).toHaveLength(32)
    expect(performanceKey).toHaveLength(32)
    expect(performanceKey).not.toEqual(evalKey)
    await expect(
      loadOrCreateEvalArtifactKey("acct_artifact_default", { platform: "web" })
    ).resolves.toEqual(evalKey)
    await expect(
      loadOrCreateAccountArtifactKey("acct_other", "performance", { platform: "web" })
    ).rejects.toThrow("unlocked account vault")
  } finally {
    __resetBrowserVaultForTesting()
    await Dexie.delete(BROWSER_VAULT_DB_NAME)
  }
})

it("derives a person partition's artifact keys from its base instead of any keyring", async () => {
  const keyring: KeyringStore = {
    save: jest.fn(),
    load: jest.fn(async () => {
      throw new Error("host keyring must not be read")
    }),
    delete: jest.fn(),
  } as unknown as KeyringStore
  await installPartitionArtifactKeyBase("pb_person", new Uint8Array(32).fill(5))
  try {
    const evalKey = await loadOrCreateEvalArtifactKey("pb_person", {
      platform: "desktop",
      keyringStore: keyring,
    })
    const submissionKey = await loadOrCreateAccountArtifactKey("pb_person", "performance", {
      platform: "desktop",
      keyringStore: keyring,
    })
    await expect(
      loadOrCreateAccountArtifactKey("pb_person", "evaluation", { platform: "desktop" })
    ).resolves.toEqual(evalKey)
    await expect(derivePartitionArtifactKey("pb_person", "performance")).resolves.toEqual(
      submissionKey
    )
    expect(submissionKey).not.toEqual(evalKey)
    expect(keyring.load).not.toHaveBeenCalled()
  } finally {
    clearPartitionArtifactKeyBase()
  }
})
