/**
 * @jest-environment jsdom
 */

import {
  buildSubscriptionPackage,
  decryptSubscriptionPackage,
  encryptSubscriptionPackage,
  SUBSCRIPTION_PACKAGE_VERSION,
  SubscriptionPassphraseError,
  summariseSubscriptionPackage,
} from "./encrypted-package"
import type { ProviderVault } from "@/types/subscription"

function vault(overrides: Partial<ProviderVault> = {}): ProviderVault {
  return {
    schemaVersion: 4,
    accounts: [],
    presets: [],
    ...overrides,
  }
}

beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    // jsdom on Node 20+ exposes Web Crypto natively. Fail fast if the test
    // host doesn't so we don't see misleading "passphrase wrong" errors.
    throw new Error("Web Crypto API is required for these tests")
  }
})

describe("buildSubscriptionPackage", () => {
  it("inventories per-provider counts and providers list", () => {
    const body = buildSubscriptionPackage(
      {
        anthropic: vault({
          accounts: [
            {
              id: "a-1",
              credential: {
                provider: "anthropic",
                accessToken: "oat",
                refreshToken: "rt",
                expiresAtMs: 0,
                mode: "subscription",
                storedAtMs: 0,
              },
              createdAtMs: 0,
              lastUsedAtMs: 0,
            },
          ],
        }),
        codex: vault({ accounts: [] }),
      },
      1_700_000_000_000
    )
    expect(body.manifest.version).toBe(SUBSCRIPTION_PACKAGE_VERSION)
    expect(body.manifest.createdAtIso).toBe("2023-11-14T22:13:20.000Z")
    expect(body.manifest.providers).toEqual(["anthropic", "codex"])
    expect(body.manifest.accountCount).toEqual({
      anthropic: 1,
      codex: 0,
      opencode: 0,
    })
  })
})

describe("encrypt + decrypt round trip", () => {
  it("recovers the exact body when the passphrase is correct", async () => {
    const body = buildSubscriptionPackage(
      {
        anthropic: vault({
          accounts: [
            {
              id: "a-1",
              label: "Pro",
              credential: {
                provider: "anthropic",
                accessToken: "oat-pro",
                refreshToken: "rt-pro",
                expiresAtMs: 1_800_000_000_000,
                mode: "subscription",
                email: "u@example.com",
                plan: "pro",
                storedAtMs: 1_700_000_000_000,
              },
              createdAtMs: 1_700_000_000_000,
              lastUsedAtMs: 1_700_000_000_000,
            },
          ],
          activeAccountId: "a-1",
        }),
      },
      1_700_000_000_000
    )
    const envelope = await encryptSubscriptionPackage(body, "correct horse battery staple")
    expect(envelope.format).toBe("cogniabak-subscription-v1")
    expect(envelope.algorithm).toBe("AES-GCM")
    expect(envelope.kdf.iterations).toBeGreaterThanOrEqual(100_000)
    expect(envelope.ciphertextB64.length).toBeGreaterThan(0)
    const restored = await decryptSubscriptionPackage(envelope, "correct horse battery staple")
    expect(restored).toEqual(body)
  })

  it("throws SubscriptionPassphraseError on a wrong passphrase", async () => {
    const body = buildSubscriptionPackage({ anthropic: vault() })
    const envelope = await encryptSubscriptionPackage(body, "right")
    await expect(decryptSubscriptionPackage(envelope, "wrong")).rejects.toBeInstanceOf(
      SubscriptionPassphraseError
    )
  })

  it("rejects empty passphrase at encrypt time", async () => {
    const body = buildSubscriptionPackage({})
    await expect(encryptSubscriptionPackage(body, "")).rejects.toThrow(/passphrase/)
  })

  it("rejects an envelope with a wrong format tag", async () => {
    const body = buildSubscriptionPackage({})
    const envelope = await encryptSubscriptionPackage(body, "p")
    const tampered = { ...envelope, format: "something-else" as never }
    await expect(decryptSubscriptionPackage(tampered, "p")).rejects.toThrow(/envelope format/)
  })

  it("rejects an envelope with the wrong algorithm tag", async () => {
    const body = buildSubscriptionPackage({})
    const envelope = await encryptSubscriptionPackage(body, "p")
    const tampered = { ...envelope, algorithm: "ChaCha20-Poly1305" as never }
    await expect(decryptSubscriptionPackage(tampered, "p")).rejects.toThrow(/algorithm/)
  })

  it("rejects an envelope from a future package version", async () => {
    const body = buildSubscriptionPackage({})
    const envelope = await encryptSubscriptionPackage(body, "p")
    // Re-encrypt the body with a tampered manifest version.
    const tamperedBody = {
      ...body,
      manifest: { ...body.manifest, version: "subscription-v999" as never },
    }
    const next = await encryptSubscriptionPackage(tamperedBody, "p")
    await expect(decryptSubscriptionPackage(next, "p")).rejects.toThrow(/version/)
    // The original envelope still decrypts cleanly.
    await expect(decryptSubscriptionPackage(envelope, "p")).resolves.toBeDefined()
  })
})

describe("summariseSubscriptionPackage", () => {
  it("counts accounts per provider", () => {
    const body = buildSubscriptionPackage({
      anthropic: vault({
        accounts: [
          {
            id: "a-1",
            credential: {
              provider: "anthropic",
              accessToken: "oat",
              refreshToken: "rt",
              expiresAtMs: 0,
              mode: "subscription",
              storedAtMs: 0,
            },
            createdAtMs: 0,
            lastUsedAtMs: 0,
          },
        ],
      }),
      codex: vault({
        accounts: [
          {
            id: "c-1",
            credential: {
              provider: "codex",
              accessToken: "oat",
              refreshToken: "",
              idTokenRaw: "",
              expiresAtMs: 0,
              authMode: "chatgpt",
              storedAtMs: 0,
            },
            createdAtMs: 0,
            lastUsedAtMs: 0,
          },
          {
            id: "c-2",
            credential: {
              provider: "codex",
              accessToken: "k",
              refreshToken: "",
              idTokenRaw: "",
              expiresAtMs: 0,
              authMode: "api_key",
              storedAtMs: 0,
            },
            createdAtMs: 0,
            lastUsedAtMs: 0,
          },
        ],
      }),
    })
    const summary = summariseSubscriptionPackage(body)
    expect(summary.providerCounts).toEqual({ anthropic: 1, codex: 2, opencode: 0 })
    expect(summary.accountIds.sort()).toEqual(["a-1", "c-1", "c-2"])
  })
})
