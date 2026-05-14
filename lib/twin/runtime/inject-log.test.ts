/**
 * Coverage for the M6 twin-injection ring buffer + subscribe semantics.
 */

import {
  __resetTwinInjectLog,
  __TESTING__,
  readTwinInjectLog,
  recordTwinInject,
  subscribeTwinInjectLog,
} from "./inject-log"

beforeEach(() => {
  __resetTwinInjectLog()
})

function dummyEntry(twinId = "twin_a") {
  return {
    ts: Date.now(),
    twinId,
    source: "test",
    applied: true,
    degraded: false,
    degradedReason: null,
    chunkCount: 3,
    styleSampleCount: 2,
    tokensApprox: 512,
  }
}

describe("recordTwinInject + readTwinInjectLog", () => {
  it("returns entries in newest-first order", () => {
    recordTwinInject(dummyEntry("twin_a"))
    recordTwinInject(dummyEntry("twin_b"))
    const log = readTwinInjectLog()
    expect(log).toHaveLength(2)
    expect(log[0].twinId).toBe("twin_b")
    expect(log[1].twinId).toBe("twin_a")
  })

  it("caps the buffer at LIMIT entries", () => {
    for (let i = 0; i < __TESTING__.LIMIT + 50; i++) {
      recordTwinInject({ ...dummyEntry(), twinId: `twin_${i}` })
    }
    expect(readTwinInjectLog()).toHaveLength(__TESTING__.LIMIT)
  })
})

describe("subscribeTwinInjectLog", () => {
  it("notifies subscribers on every new entry", () => {
    const calls: string[] = []
    const unsubscribe = subscribeTwinInjectLog((e) => calls.push(e.twinId))
    recordTwinInject(dummyEntry("twin_a"))
    recordTwinInject(dummyEntry("twin_b"))
    expect(calls).toEqual(["twin_a", "twin_b"])
    unsubscribe()
    recordTwinInject(dummyEntry("twin_c"))
    expect(calls).toEqual(["twin_a", "twin_b"])
  })

  it("survives a subscriber that throws", () => {
    subscribeTwinInjectLog(() => {
      throw new Error("boom")
    })
    const calls: string[] = []
    subscribeTwinInjectLog((e) => calls.push(e.twinId))
    expect(() => recordTwinInject(dummyEntry("twin_a"))).not.toThrow()
    expect(calls).toEqual(["twin_a"])
  })
})
