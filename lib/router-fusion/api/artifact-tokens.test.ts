/**
 * A Browser Vault double: an account id, a lock, and a secret store that
 * outlives any one "process" (the module-level key cache), as the real
 * vault's IndexedDB repository does.
 */
const mockVaultSecrets = new Map<string, string>()
const mockVault = {
  current: null as null | {
    accountId: string
    unlocked: boolean
    isUnlocked(): boolean
    loadSecret(name: string): Promise<string | null>
    storeSecret(name: string, value: string): Promise<void>
  },
}
jest.mock("@/lib/runtime/browser-vault", () => ({
  getActiveBrowserVault: () => mockVault.current,
}))

function openVault(accountId: string) {
  const vault = {
    accountId,
    unlocked: true,
    isUnlocked() {
      return this.unlocked
    },
    loadSecret: jest.fn(
      async (name: string) => mockVaultSecrets.get(`${accountId}/${name}`) ?? null
    ),
    storeSecret: jest.fn(async (name: string, value: string) => {
      mockVaultSecrets.set(`${accountId}/${name}`, value)
    }),
  }
  mockVault.current = vault
  return vault
}

import { RouterFusionInfrastructureError } from "../gate/faults"
import {
  __resetArtifactTokenKeyForTesting,
  ARTIFACT_READ_TOKEN_TTL_MS,
  ARTIFACT_TOKEN_KEY_SECRET,
  issueArtifactReadToken,
  verifyArtifactReadToken,
} from "./artifact-tokens"

const NOW = 1_800_000_000_000

beforeEach(() => {
  __resetArtifactTokenKeyForTesting()
  mockVaultSecrets.clear()
  mockVault.current = null
})

describe("artifact read tokens", () => {
  it("lasts the spec's sixty seconds", async () => {
    const issued = await issueArtifactReadToken("art-1", "key-a", NOW)
    expect(ARTIFACT_READ_TOKEN_TTL_MS).toBe(60_000)
    expect(issued.expiresAt).toBe(NOW + 60_000)
    await expect(
      verifyArtifactReadToken(issued.token, "art-1", "key-a", NOW + 59_999)
    ).resolves.toBe("valid")
    await expect(
      verifyArtifactReadToken(issued.token, "art-1", "key-a", NOW + 60_000)
    ).resolves.toBe("expired")
  })

  it("grants one artifact to one key and nothing else", async () => {
    const { token } = await issueArtifactReadToken("art-1", "key-a", NOW)
    await expect(verifyArtifactReadToken(token, "art-2", "key-a", NOW)).resolves.toBe("invalid")
    await expect(verifyArtifactReadToken(token, "art-1", "key-b", NOW)).resolves.toBe("invalid")
    await expect(verifyArtifactReadToken(token, "art-1", null, NOW)).resolves.toBe("invalid")
  })

  it("refuses a token whose expiry was edited", async () => {
    const { token, expiresAt } = await issueArtifactReadToken("art-1", "key-a", NOW)
    const forged = `${expiresAt + 3_600_000}${token.slice(token.indexOf("."))}`
    await expect(verifyArtifactReadToken(forged, "art-1", "key-a", NOW)).resolves.toBe("invalid")
  })

  it.each([undefined, 42, "", "no-dot", "abc.def", "123.!!!", ".sig"])(
    "treats %p as no token at all",
    async (token) => {
      await expect(verifyArtifactReadToken(token, "art-1", "key-a", NOW)).resolves.toBe("invalid")
    }
  )

  it("without an account vault, forgets every token when the brain restarts", async () => {
    // The legacy, non-account database: no vault to keep a key in.
    const { token } = await issueArtifactReadToken("art-1", "key-a", NOW)
    __resetArtifactTokenKeyForTesting()
    await expect(verifyArtifactReadToken(token, "art-1", "key-a", NOW)).resolves.toBe("invalid")
  })
})

describe("the account's signing key", () => {
  it("survives a brain restart: a link issued before it is still valid after", async () => {
    openVault("acct-a")
    const { token } = await issueArtifactReadToken("art-1", "key-a", NOW)
    // A reloaded window or a restarted headless brain: nothing in memory survives.
    __resetArtifactTokenKeyForTesting()
    openVault("acct-a")
    await expect(verifyArtifactReadToken(token, "art-1", "key-a", NOW + 5_000)).resolves.toBe(
      "valid"
    )
    // Still bound to what it grants.
    await expect(verifyArtifactReadToken(token, "art-2", "key-a", NOW)).resolves.toBe("invalid")
  })

  it("is minted once per account, kept only in the vault, and loaded once per process", async () => {
    const vault = openVault("acct-a")
    await issueArtifactReadToken("art-1", "key-a", NOW)
    await issueArtifactReadToken("art-2", "key-a", NOW)
    expect(vault.storeSecret).toHaveBeenCalledTimes(1)
    expect(vault.storeSecret.mock.calls[0][0]).toBe(ARTIFACT_TOKEN_KEY_SECRET)
    // 256 bits, base64url.
    expect(vault.storeSecret.mock.calls[0][1]).toMatch(/^[A-Za-z0-9_-]{43}$/)

    __resetArtifactTokenKeyForTesting()
    const again = openVault("acct-a")
    await issueArtifactReadToken("art-3", "key-a", NOW)
    expect(again.storeSecret).not.toHaveBeenCalled()
  })

  it("is the account's own: another account cannot validate its links", async () => {
    openVault("acct-a")
    const { token } = await issueArtifactReadToken("art-1", "key-a", NOW)
    openVault("acct-b")
    await expect(verifyArtifactReadToken(token, "art-1", "key-a", NOW)).resolves.toBe("invalid")
    openVault("acct-a")
    await expect(verifyArtifactReadToken(token, "art-1", "key-a", NOW)).resolves.toBe("valid")
  })

  it("replaces a stored key it cannot read rather than signing with a guess", async () => {
    mockVaultSecrets.set(`acct-a/${ARTIFACT_TOKEN_KEY_SECRET}`, "not-a-key")
    const vault = openVault("acct-a")
    const { token } = await issueArtifactReadToken("art-1", "key-a", NOW)
    expect(vault.storeSecret).toHaveBeenCalledTimes(1)
    __resetArtifactTokenKeyForTesting()
    openVault("acct-a")
    await expect(verifyArtifactReadToken(token, "art-1", "key-a", NOW)).resolves.toBe("valid")
  })

  it("is a fault while the vault is locked, and recovers once it unlocks", async () => {
    const vault = openVault("acct-a")
    vault.unlocked = false
    await expect(issueArtifactReadToken("art-1", "key-a", NOW)).rejects.toBeInstanceOf(
      RouterFusionInfrastructureError
    )
    vault.unlocked = true
    const { token } = await issueArtifactReadToken("art-1", "key-a", NOW)
    await expect(verifyArtifactReadToken(token, "art-1", "key-a", NOW)).resolves.toBe("valid")
  })

  it("does not remember a failed load", async () => {
    const vault = openVault("acct-a")
    vault.loadSecret.mockRejectedValueOnce(new Error("vault database closed"))
    await expect(issueArtifactReadToken("art-1", "key-a", NOW)).rejects.toThrow("closed")
    const { token } = await issueArtifactReadToken("art-1", "key-a", NOW)
    await expect(verifyArtifactReadToken(token, "art-1", "key-a", NOW)).resolves.toBe("valid")
  })
})
