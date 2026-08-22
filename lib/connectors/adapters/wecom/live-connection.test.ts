import {
  __resetWeComLiveConnectionsForTests,
  findWeComLiveConnection,
  registerWeComLiveConnection,
  weComCredentialFingerprint,
  type WeComLiveConnection,
} from "./live-connection"

function make(botId: string, adapterId = "a1"): WeComLiveConnection {
  return {
    adapterId,
    botId,
    credentialFingerprint: `fp:${botId}:${adapterId}`,
    health: () => ({ state: "running" }),
  }
}

beforeEach(() => {
  __resetWeComLiveConnectionsForTests()
})

describe("weComCredentialFingerprint", () => {
  it("is stable for the same pair", async () => {
    await expect(weComCredentialFingerprint("b", "s")).resolves.toBe(
      await weComCredentialFingerprint("b", "s")
    )
  })

  it("changes when either half changes", async () => {
    const base = await weComCredentialFingerprint("b", "s")
    expect(await weComCredentialFingerprint("b", "s2")).not.toBe(base)
    expect(await weComCredentialFingerprint("b2", "s")).not.toBe(base)
  })

  it("does not contain the secret", async () => {
    const fingerprint = await weComCredentialFingerprint("bot", "super-secret")
    expect(fingerprint).not.toContain("super-secret")
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/)
  })

  it("cannot be forged by shifting the delimiter between the two halves", async () => {
    // "a" + ":b" and "a:" + "b" must not collide — a bot id containing the
    // separator would otherwise let one bot's fingerprint match another's.
    expect(await weComCredentialFingerprint("a", ":b")).not.toBe(
      await weComCredentialFingerprint("a:", "b")
    )
  })
})

describe("the live-connection registry", () => {
  it("finds a registered connection by bot id", () => {
    registerWeComLiveConnection(make("bot-1"))
    expect(findWeComLiveConnection("bot-1")?.adapterId).toBe("a1")
    expect(findWeComLiveConnection("bot-2")).toBeUndefined()
  })

  it("lets the newest registration win — only one socket can exist per bot", () => {
    registerWeComLiveConnection(make("bot-1", "a1"))
    registerWeComLiveConnection(make("bot-1", "a2"))
    expect(findWeComLiveConnection("bot-1")?.adapterId).toBe("a2")
  })

  it("unregisters its own entry", () => {
    const dispose = registerWeComLiveConnection(make("bot-1"))
    dispose()
    expect(findWeComLiveConnection("bot-1")).toBeUndefined()
  })

  it("does not let a late teardown clear a newer registration", () => {
    // Restart order: the new adapter subscribes before the old one's stop()
    // runs. The stale disposer must be a no-op, or the running bot's slot
    // disappears and a probe opens a socket that fights it.
    const disposeOld = registerWeComLiveConnection(make("bot-1", "old"))
    registerWeComLiveConnection(make("bot-1", "new"))
    disposeOld()
    expect(findWeComLiveConnection("bot-1")?.adapterId).toBe("new")
  })

  it("reads health live rather than snapshotting it", () => {
    let state: "running" | "degraded" = "running"
    registerWeComLiveConnection({
      adapterId: "a1",
      botId: "bot-1",
      credentialFingerprint: "fp",
      health: () => ({ state }),
    })
    expect(findWeComLiveConnection("bot-1")?.health().state).toBe("running")
    state = "degraded"
    expect(findWeComLiveConnection("bot-1")?.health().state).toBe("degraded")
  })

  it("keeps bots independent", () => {
    registerWeComLiveConnection(make("bot-1"))
    const dispose2 = registerWeComLiveConnection(make("bot-2"))
    dispose2()
    expect(findWeComLiveConnection("bot-1")).toBeDefined()
    expect(findWeComLiveConnection("bot-2")).toBeUndefined()
  })
})
