import {
  __setAbandonedTurnDepsForTests,
  forgetOpenBundleTurn,
  liveBundleTurnIds,
  reclaimAbandonedBundleTurns,
  rememberOpenBundleTurn,
  type AbandonedTurnChannel,
} from "./abandoned-turns"

/**
 * One same-origin bus, so a "peer tab" is just a second channel on it. That is
 * the shape the real thing has, and it is the only way to exercise the claim
 * protocol rather than a mock of it.
 */
function fakeBus() {
  const channels: Array<{
    channel: AbandonedTurnChannel
    listeners: Set<(e: { data: unknown }) => void>
  }> = []
  const open = (): AbandonedTurnChannel => {
    const listeners = new Set<(e: { data: unknown }) => void>()
    const channel: AbandonedTurnChannel = {
      postMessage: (message) => {
        for (const peer of channels) {
          // A BroadcastChannel never delivers to itself.
          if (peer.channel === channel) continue
          for (const listener of [...peer.listeners]) listener({ data: message })
        }
      },
      addEventListener: (_type, listener) => {
        listeners.add(listener)
      },
      removeEventListener: (_type, listener) => {
        listeners.delete(listener)
      },
      close: () => {
        const index = channels.findIndex((entry) => entry.channel === channel)
        if (index >= 0) channels.splice(index, 1)
      },
    }
    channels.push({ channel, listeners })
    return channel
  }
  return {
    open,
    get openCount() {
      return channels.length
    },
  }
}

function harness(over: { openChannel?: () => AbandonedTurnChannel | null } = {}) {
  let stored: string | null = null
  const aborted: string[] = []
  const bus = fakeBus()
  const restore = __setAbandonedTurnDepsForTests({
    readStorage: () => stored,
    writeStorage: (value) => {
      stored = value
    },
    openChannel: over.openChannel ?? bus.open,
    abort: async (bundleTurnId) => {
      aborted.push(bundleTurnId)
      return {}
    },
    now: () => 1_700_000_000_000,
    // Claims are delivered synchronously on this bus, so the poll only has to
    // yield once rather than wait out the real window.
    waitForClaims: async () => {},
  })
  return {
    aborted,
    bus,
    records: () => (stored ? (JSON.parse(stored) as Array<{ bundleTurnId: string }>) : []),
    seedRecords: (records: unknown) => {
      stored = JSON.stringify(records)
    },
    restore,
  }
}

let h: ReturnType<typeof harness>

afterEach(() => {
  h?.restore()
})

describe("recording what this document drives", () => {
  it("remembers a turn and forgets it once it settles", () => {
    h = harness()
    rememberOpenBundleTurn({ bundleTurnId: "wbt_1", sessionId: "s_1", openedAt: 1 })
    expect(h.records().map((r) => r.bundleTurnId)).toEqual(["wbt_1"])
    expect(liveBundleTurnIds()).toEqual(["wbt_1"])

    forgetOpenBundleTurn("wbt_1")
    expect(h.records()).toEqual([])
    expect(liveBundleTurnIds()).toEqual([])
  })

  it("does not record the same turn twice", () => {
    h = harness()
    rememberOpenBundleTurn({ bundleTurnId: "wbt_1", sessionId: "s_1", openedAt: 1 })
    rememberOpenBundleTurn({ bundleTurnId: "wbt_1", sessionId: "s_1", openedAt: 2 })
    expect(h.records()).toHaveLength(1)
  })
})

describe("reclaiming", () => {
  // The reload case: the previous page left a turn open, this one has no live
  // turns at all, and no other tab claims it.
  it("aborts a turn no tab claims", async () => {
    h = harness()
    h.seedRecords([{ bundleTurnId: "wbt_1", sessionId: "s_1", openedAt: 1 }])
    await expect(reclaimAbandonedBundleTurns("s_1")).resolves.toEqual(["wbt_1"])
    expect(h.aborted).toEqual(["wbt_1"])
    // The record goes with it, so the next refusal does not re-poll for a turn
    // that is already gone.
    expect(h.records()).toEqual([])
  })

  // A second tab of the same browser is mid-turn. Aborting its run would leave
  // its changes uncaptured while its agent keeps writing, so the refusal that
  // sent us here was correct and must stand.
  it("leaves a turn another tab is still driving alone", async () => {
    h = harness()
    // The "other tab": a responder attached to the same bus holding the turn.
    const peer = h.bus.open()
    peer.addEventListener("message", (event) => {
      const message = event.data as { kind?: string; nonce?: string; bundleTurnIds?: string[] }
      if (message?.kind !== "cognia.bundle-turn.poll") return
      const claimed = (message.bundleTurnIds ?? []).filter((id) => id === "wbt_1")
      if (claimed.length === 0) return
      peer.postMessage({
        kind: "cognia.bundle-turn.claim",
        nonce: message.nonce,
        bundleTurnIds: claimed,
      })
    })
    h.seedRecords([{ bundleTurnId: "wbt_1", sessionId: "s_1", openedAt: 1 }])

    await expect(reclaimAbandonedBundleTurns("s_1")).resolves.toEqual([])
    expect(h.aborted).toEqual([])
    expect(h.records().map((r) => r.bundleTurnId)).toEqual(["wbt_1"])
  })

  // This document's own turns are claimed without going near the bus, so a
  // concurrent send inside one tab cannot abort the turn it is running.
  it("never aborts a turn this document is driving", async () => {
    h = harness()
    rememberOpenBundleTurn({ bundleTurnId: "wbt_1", sessionId: "s_1", openedAt: 1 })
    await expect(reclaimAbandonedBundleTurns("s_1")).resolves.toEqual([])
    expect(h.aborted).toEqual([])
  })

  // Another conversation's abandoned turn is not this refusal's business, and
  // ending it would release a working copy nobody asked about.
  it("only considers the conversation that was refused", async () => {
    h = harness()
    h.seedRecords([
      { bundleTurnId: "wbt_1", sessionId: "s_1", openedAt: 1 },
      { bundleTurnId: "wbt_2", sessionId: "s_2", openedAt: 1 },
    ])
    await reclaimAbandonedBundleTurns("s_1")
    expect(h.aborted).toEqual(["wbt_1"])
    expect(h.records().map((r) => r.bundleTurnId)).toEqual(["wbt_2"])
  })

  // Unable to ask is not the same as nobody answered. Treating a missing
  // channel as "no claimants" would abort a turn that is running perfectly.
  it("reclaims nothing when it cannot poll at all", async () => {
    h = harness({ openChannel: () => null })
    h.seedRecords([{ bundleTurnId: "wbt_1", sessionId: "s_1", openedAt: 1 }])
    await expect(reclaimAbandonedBundleTurns("s_1")).resolves.toEqual([])
    expect(h.aborted).toEqual([])
  })

  // The host can refuse the abort (already settled, or this device may not
  // touch it). That is not a released turn, so the caller must not retry on it.
  it("does not report a turn the host refused to end", async () => {
    let stored = JSON.stringify([{ bundleTurnId: "wbt_1", sessionId: "s_1", openedAt: 1 }])
    const bus = fakeBus()
    const restore = __setAbandonedTurnDepsForTests({
      readStorage: () => stored,
      writeStorage: (value) => {
        stored = value
      },
      openChannel: bus.open,
      abort: async () => {
        throw new Error("unknown workspace bundle turn: wbt_1")
      },
      now: () => 1,
      waitForClaims: async () => {},
    })
    try {
      await expect(reclaimAbandonedBundleTurns("s_1")).resolves.toEqual([])
      // Still retired locally: nothing here will ever end it, so keeping the
      // record would make every later refusal re-poll for it.
      expect(JSON.parse(stored)).toEqual([])
    } finally {
      restore()
    }
  })

  it("survives storage that holds something other than a list", async () => {
    h = harness()
    h.seedRecords({ not: "an array" })
    await expect(reclaimAbandonedBundleTurns("s_1")).resolves.toEqual([])
  })
})

describe("the poll leaves nothing behind", () => {
  // A channel per poll, closed in a `finally`. A leaked one keeps answering
  // for turns this document stopped driving.
  it("closes every channel it opened", async () => {
    h = harness()
    h.seedRecords([{ bundleTurnId: "wbt_1", sessionId: "s_1", openedAt: 1 }])
    await reclaimAbandonedBundleTurns("s_1")
    expect(h.bus.openCount).toBe(0)
  })

  it("stops answering once the last turn settles", () => {
    h = harness()
    rememberOpenBundleTurn({ bundleTurnId: "wbt_1", sessionId: "s_1", openedAt: 1 })
    expect(h.bus.openCount).toBe(1)
    forgetOpenBundleTurn("wbt_1")
    expect(h.bus.openCount).toBe(0)
  })
})
