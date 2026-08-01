import path from "node:path"

import { createMemoryFs, type MemoryFs } from "./test-fs"
import {
  LEASE_HEARTBEAT_MS,
  LEASE_STALE_AFTER_MS,
  acquireLease,
  defaultIsProcessAlive,
  isLeaseStale,
  readLease,
  releaseLease,
  renewLease,
  startLeaseHeartbeat,
  type LeaseEnvironment,
  type SessionLease,
} from "./lease"
import { leasePath } from "./paths"

const HOME = path.join(path.sep, "home", "u", ".cognia")

function env(fsx: MemoryFs, overrides: Partial<LeaseEnvironment> = {}): LeaseEnvironment {
  let token = 0
  return {
    fsx,
    home: HOME,
    now: () => 1_000_000,
    host: "host-a",
    pid: 100,
    mintToken: () => `tok-${(token += 1)}`,
    isProcessAlive: () => true,
    ...overrides,
  }
}

describe("acquireLease", () => {
  it("takes a free lease and records pid, host, start time and token", () => {
    const fsx = createMemoryFs()
    const result = acquireLease("s1", env(fsx))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.reclaimed).toBe(false)
    expect(result.lease).toMatchObject({
      leaseVersion: 1,
      sessionId: "s1",
      pid: 100,
      host: "host-a",
      token: "tok-1",
      heartbeatAt: 1_000_000,
    })
    expect(result.lease.startedAt).toBe(new Date(1_000_000).toISOString())
    expect(fsx.files.has(leasePath(HOME, "s1"))).toBe(true)
  })

  it("refuses a lease held by a live writer and reports the holder", () => {
    const fsx = createMemoryFs()
    const first = acquireLease("s1", env(fsx))
    expect(first.ok).toBe(true)

    const second = acquireLease("s1", env(fsx, { pid: 200 }))
    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.heldBy).toMatchObject({ pid: 100, host: "host-a" })
  })

  it("reclaims a lease whose heartbeat has gone cold", () => {
    const fsx = createMemoryFs()
    acquireLease("s1", env(fsx))
    const later = env(fsx, {
      now: () => 1_000_000 + LEASE_STALE_AFTER_MS + 1,
      pid: 200,
      // Pretend the old pid still exists: the heartbeat alone must be enough.
      isProcessAlive: () => true,
    })
    const result = acquireLease("s1", later)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.reclaimed).toBe(true)
    expect(result.lease.pid).toBe(200)
  })

  it("reclaims a same-host lease whose pid is gone, even with a fresh heartbeat", () => {
    const fsx = createMemoryFs()
    acquireLease("s1", env(fsx))
    const result = acquireLease("s1", env(fsx, { pid: 200, isProcessAlive: (pid) => pid !== 100 }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.reclaimed).toBe(true)
  })

  it("never steals a fresh lease from another host, whose process table it cannot see", () => {
    const fsx = createMemoryFs()
    acquireLease("s1", env(fsx, { host: "host-b" }))
    const result = acquireLease(
      "s1",
      env(fsx, { host: "host-a", pid: 200, isProcessAlive: () => false })
    )
    expect(result.ok).toBe(false)
  })

  it("reclaims a malformed lease file rather than stranding the session", () => {
    const fsx = createMemoryFs({ [leasePath(HOME, "s1")]: "{ not json" })
    const result = acquireLease("s1", env(fsx))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.reclaimed).toBe(true)
  })

  it("reports a conflict when another process wins the re-race after a stale drop", () => {
    const fsx = createMemoryFs()
    acquireLease("s1", env(fsx))
    // Simulate the competitor landing between our remove and our exclusive create.
    const racing = { ...fsx, writeFileExclusive: () => false } as MemoryFs
    const result = acquireLease("s1", env(racing, { now: () => 9_000_000, pid: 300 }))
    expect(result.ok).toBe(false)
  })
})

describe("isLeaseStale", () => {
  const base = { now: 1_000, host: "host-a", isProcessAlive: () => true, staleAfterMs: 100 }

  it("treats a missing lease as stale", () => {
    expect(isLeaseStale(null, base)).toBe(true)
  })

  it("treats a fresh same-host lease with a live pid as held", () => {
    const lease: SessionLease = {
      leaseVersion: 1,
      sessionId: "s1",
      pid: 1,
      host: "host-a",
      startedAt: "x",
      token: "t",
      heartbeatAt: 1_000,
    }
    expect(isLeaseStale(lease, base)).toBe(false)
  })
})

describe("renewLease / releaseLease", () => {
  it("advances the heartbeat and keeps the same token", () => {
    const fsx = createMemoryFs()
    const taken = acquireLease("s1", env(fsx))
    if (!taken.ok) throw new Error("expected lease")
    const renewEnv = env(fsx, { now: () => 1_500_000 })
    expect(renewLease(taken.lease, renewEnv)).toBe(true)
    expect(taken.lease.heartbeatAt).toBe(1_500_000)
    expect(readLease("s1", renewEnv)?.token).toBe("tok-1")
  })

  it("reports a lost lease when the file is gone or another token owns it", () => {
    const fsx = createMemoryFs()
    const taken = acquireLease("s1", env(fsx))
    if (!taken.ok) throw new Error("expected lease")
    fsx.files.delete(leasePath(HOME, "s1"))
    expect(renewLease(taken.lease, env(fsx))).toBe(false)

    acquireLease("s1", env(fsx, { mintToken: () => "other" }))
    expect(renewLease(taken.lease, env(fsx))).toBe(false)
  })

  it("releases its own lease and leaves someone else's alone", () => {
    const fsx = createMemoryFs()
    const taken = acquireLease("s1", env(fsx))
    if (!taken.ok) throw new Error("expected lease")
    releaseLease(taken.lease, env(fsx))
    expect(readLease("s1", env(fsx))).toBeNull()

    const other = acquireLease("s1", env(fsx, { mintToken: () => "other" }))
    if (!other.ok) throw new Error("expected lease")
    releaseLease(taken.lease, env(fsx))
    expect(readLease("s1", env(fsx))?.token).toBe("other")
  })

  it("reads null for a session with no lease at all", () => {
    expect(readLease("nope", env(createMemoryFs()))).toBeNull()
  })
})

describe("startLeaseHeartbeat", () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it("renews on the cadence until stopped", () => {
    const fsx = createMemoryFs()
    let clock = 1_000_000
    const holder = env(fsx, { now: () => clock })
    const taken = acquireLease("s1", holder)
    if (!taken.ok) throw new Error("expected lease")

    const stop = startLeaseHeartbeat(taken.lease, holder, undefined, LEASE_HEARTBEAT_MS)
    clock += LEASE_HEARTBEAT_MS
    jest.advanceTimersByTime(LEASE_HEARTBEAT_MS)
    expect(readLease("s1", holder)?.heartbeatAt).toBe(clock)

    stop()
    clock += LEASE_HEARTBEAT_MS
    jest.advanceTimersByTime(LEASE_HEARTBEAT_MS)
    expect(readLease("s1", holder)?.heartbeatAt).toBe(clock - LEASE_HEARTBEAT_MS)
  })

  it("stops itself and notifies when the lease is lost", () => {
    const fsx = createMemoryFs()
    const holder = env(fsx)
    const taken = acquireLease("s1", holder)
    if (!taken.ok) throw new Error("expected lease")
    const onLost = jest.fn()
    startLeaseHeartbeat(taken.lease, holder, onLost, LEASE_HEARTBEAT_MS)

    fsx.files.delete(leasePath(HOME, "s1"))
    jest.advanceTimersByTime(LEASE_HEARTBEAT_MS)
    expect(onLost).toHaveBeenCalledTimes(1)

    jest.advanceTimersByTime(LEASE_HEARTBEAT_MS * 3)
    expect(onLost).toHaveBeenCalledTimes(1)
  })
})

describe("defaultIsProcessAlive", () => {
  it("sees this very process as alive and a bogus pid as dead", () => {
    expect(defaultIsProcessAlive(process.pid)).toBe(true)
    expect(defaultIsProcessAlive(2_147_483_646)).toBe(false)
  })
})
