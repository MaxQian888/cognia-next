import {
  _defaultMintToken,
  _peekInstallationCache,
  clearInstallationTokenCache,
  evictInstallationToken,
  getInstallationToken,
} from "./auth-app"

const CFG = {
  appId: 12345,
  privateKey: "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----",
}
const INSTALL = 99999

beforeEach(() => clearInstallationTokenCache())

describe("getInstallationToken", () => {
  it("mints a new token on cache miss", async () => {
    const mintToken = jest.fn(async () => ({
      token: "ghs_minted",
      expiresAt: Date.now() + 60 * 60_000,
    }))
    const tok = await getInstallationToken(CFG, INSTALL, { mintToken })
    expect(tok).toBe("ghs_minted")
    expect(mintToken).toHaveBeenCalledTimes(1)
  })

  it("returns cached token while it has > 5 minutes left", async () => {
    const now = 1_000_000
    const mintToken = jest.fn(async () => ({
      token: "ghs_first",
      expiresAt: now + 30 * 60_000, // 30 min remaining
    }))
    const t1 = await getInstallationToken(CFG, INSTALL, { mintToken, now: () => now })
    const t2 = await getInstallationToken(CFG, INSTALL, { mintToken, now: () => now + 1000 })
    expect(t1).toBe("ghs_first")
    expect(t2).toBe("ghs_first")
    expect(mintToken).toHaveBeenCalledTimes(1)
  })

  it("refreshes when fewer than 5 minutes remain", async () => {
    const now = 1_000_000
    const tokens = ["ghs_first", "ghs_refreshed"]
    const mintToken = jest.fn(async () => ({
      token: tokens.shift()!,
      expiresAt: now + 4 * 60_000, // 4 min — under refresh threshold
    }))
    const t1 = await getInstallationToken(CFG, INSTALL, { mintToken, now: () => now })
    const t2 = await getInstallationToken(CFG, INSTALL, { mintToken, now: () => now })
    expect(t1).toBe("ghs_first")
    expect(t2).toBe("ghs_refreshed")
    expect(mintToken).toHaveBeenCalledTimes(2)
  })

  it("isolates tokens per (appId, installationId) pair", async () => {
    const mintToken = jest.fn(async (cfg, installId) => ({
      token: `tok-${cfg.appId}-${installId}`,
      expiresAt: Date.now() + 60 * 60_000,
    }))
    const a = await getInstallationToken(CFG, 1, { mintToken })
    const b = await getInstallationToken(CFG, 2, { mintToken })
    const c = await getInstallationToken({ ...CFG, appId: 99 }, 1, { mintToken })
    expect(a).toBe("tok-12345-1")
    expect(b).toBe("tok-12345-2")
    expect(c).toBe("tok-99-1")
  })
})

describe("evictInstallationToken", () => {
  it("removes the cached entry, forcing a re-mint on the next call", async () => {
    const tokens = ["ghs_first", "ghs_after_evict"]
    const mintToken = jest.fn(async () => ({
      token: tokens.shift()!,
      expiresAt: Date.now() + 60 * 60_000,
    }))
    await getInstallationToken(CFG, INSTALL, { mintToken })
    expect(_peekInstallationCache(CFG.appId, INSTALL)).toBeDefined()
    evictInstallationToken(CFG.appId, INSTALL)
    expect(_peekInstallationCache(CFG.appId, INSTALL)).toBeUndefined()
    const t = await getInstallationToken(CFG, INSTALL, { mintToken })
    expect(t).toBe("ghs_after_evict")
    expect(mintToken).toHaveBeenCalledTimes(2)
  })
})

describe("_defaultMintToken", () => {
  it("delegates to createAppAuth and parses the ISO expiresAt", async () => {
    const minted = await _defaultMintToken(CFG, 100)
    expect(typeof minted.token).toBe("string")
    expect(minted.token).toMatch(/^ghs_/)
    expect(typeof minted.expiresAt).toBe("number")
    expect(minted.expiresAt).toBeGreaterThan(Date.now())
  })

  it("is invoked by getInstallationToken when no minter is supplied", async () => {
    clearInstallationTokenCache()
    const t = await getInstallationToken(CFG, 200)
    expect(typeof t).toBe("string")
    expect(t).toMatch(/^ghs_/)
  })
})

describe("default time source", () => {
  it("uses Date.now() when no `now` override is provided", async () => {
    const real = Date.now
    Date.now = () => 5_000_000
    try {
      const mintToken = jest.fn(async () => ({
        token: "ghs_realnow",
        expiresAt: 5_000_000 + 60 * 60_000,
      }))
      const t = await getInstallationToken(CFG, INSTALL, { mintToken })
      expect(t).toBe("ghs_realnow")
    } finally {
      Date.now = real
    }
  })
})
