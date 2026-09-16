/**
 * @jest-environment node
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { LEASE_HEARTBEAT_MS, LEASE_STALE_AFTER_MS } from "../agent/session-store/lease"
import {
  acquireStoreLock,
  readStoreLock,
  releaseStoreLock,
  renewStoreLock,
  startStoreLockHeartbeat,
  storeLockPath,
  type StoreLockEnvironment,
} from "./store-lock"

let dir: string
let file: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-store-lock-"))
  file = path.join(dir, "db.json")
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function env(overrides: Partial<StoreLockEnvironment> = {}): StoreLockEnvironment {
  let token = 0
  return {
    now: () => 1_000_000,
    host: "host-a",
    pid: 100,
    mintToken: () => `tok-${(token += 1)}`,
    isProcessAlive: () => true,
    cliVersion: "0.0.0-test",
    ...overrides,
  }
}

describe("acquireStoreLock", () => {
  it("takes a free lock beside the snapshot and records holder metadata", () => {
    const result = acquireStoreLock(file, env())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.reclaimed).toBe(false)
    expect(result.lock).toMatchObject({
      lockVersion: 1,
      pid: 100,
      host: "host-a",
      token: "tok-1",
      heartbeatAt: 1_000_000,
      cliVersion: "0.0.0-test",
    })
    expect(result.lock.startedAt).toBe(new Date(1_000_000).toISOString())
    expect(fs.existsSync(storeLockPath(file))).toBe(true)
  })

  it("refuses a lock held by a live writer and reports the holder", () => {
    expect(acquireStoreLock(file, env()).ok).toBe(true)
    const second = acquireStoreLock(file, env({ pid: 200 }))
    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.heldBy).toMatchObject({ pid: 100, host: "host-a" })
  })

  it("reclaims a foreign-host lock whose heartbeat has gone cold", () => {
    acquireStoreLock(file, env({ host: "host-b" }))
    const result = acquireStoreLock(
      file,
      env({
        now: () => 1_000_000 + LEASE_STALE_AFTER_MS + 1,
        pid: 200,
        // Pretend the old pid still exists: the heartbeat alone must be enough.
        isProcessAlive: () => true,
      })
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.reclaimed).toBe(true)
    expect(result.lock.pid).toBe(200)
  })

  it("keeps a same-host lock whose pid is alive even when its heartbeat is cold (suspend/resume)", () => {
    acquireStoreLock(file, env())
    const result = acquireStoreLock(
      file,
      env({
        now: () => 1_000_000 + LEASE_STALE_AFTER_MS + 1,
        pid: 200,
        isProcessAlive: () => true,
      })
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.heldBy).toMatchObject({ pid: 100, host: "host-a" })
  })

  it("reclaims a same-host lock whose pid is gone, even with a fresh heartbeat", () => {
    acquireStoreLock(file, env())
    const result = acquireStoreLock(file, env({ pid: 200, isProcessAlive: (pid) => pid !== 100 }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.reclaimed).toBe(true)
  })

  it("never steals a fresh lock from another host, whose process table it cannot see", () => {
    acquireStoreLock(file, env({ host: "host-b" }))
    const result = acquireStoreLock(
      file,
      env({ host: "host-a", pid: 200, isProcessAlive: () => false })
    )
    expect(result.ok).toBe(false)
  })

  it("creates the store directory on a first-ever boot so the first process can write", () => {
    const missing = path.join(dir, "never-existed", "db.json")
    const result = acquireStoreLock(missing, env())
    expect(result.ok).toBe(true)
    expect(fs.existsSync(storeLockPath(missing))).toBe(true)
  })

  it("reclaims a malformed lock file rather than stranding the store", () => {
    fs.writeFileSync(storeLockPath(file), "{ not json")
    const result = acquireStoreLock(file, env())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.reclaimed).toBe(true)
  })

  it("reports a conflict when another process wins the re-race after a stale drop", () => {
    acquireStoreLock(file, env())
    // Simulate the competitor landing between our remove and our exclusive
    // create by refusing the create and writing its record instead.
    const staleNow = 1_000_000 + LEASE_STALE_AFTER_MS + 1
    const racing = env({ now: () => staleNow, pid: 300 })
    const original = fs.writeFileSync
    const spy = jest.spyOn(fs, "writeFileSync").mockImplementation(((
      target: fs.PathOrFileDescriptor,
      body: string,
      options?: unknown
    ) => {
      if (
        typeof target === "string" &&
        target === storeLockPath(file) &&
        (options as { flag?: string })?.flag === "wx"
      ) {
        // The competitor's record appears where ours would have gone.
        original(
          target,
          JSON.stringify({
            lockVersion: 1,
            pid: 400,
            host: "host-a",
            startedAt: new Date(staleNow).toISOString(),
            token: "competitor",
            heartbeatAt: staleNow,
            cliVersion: "0.0.0-test",
          })
        )
        const error = new Error("EEXIST") as NodeJS.ErrnoException
        error.code = "EEXIST"
        throw error
      }
      return original(target as string, body, options as never)
    }) as typeof fs.writeFileSync)
    try {
      const result = acquireStoreLock(file, racing)
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.heldBy).toMatchObject({ pid: 400, token: "competitor" })
    } finally {
      spy.mockRestore()
    }
  })
})

describe("renewStoreLock / releaseStoreLock", () => {
  it("advances the heartbeat and keeps the same token", () => {
    const taken = acquireStoreLock(file, env())
    if (!taken.ok) throw new Error("expected lock")
    const renewEnv = env({ now: () => 1_500_000 })
    expect(renewStoreLock(taken.lock, file, renewEnv)).toBe(true)
    expect(taken.lock.heartbeatAt).toBe(1_500_000)
    expect(readStoreLock(file)?.token).toBe("tok-1")
  })

  it("reports a lost lock when the file is gone or another token owns it", () => {
    const taken = acquireStoreLock(file, env())
    if (!taken.ok) throw new Error("expected lock")
    fs.rmSync(storeLockPath(file))
    expect(renewStoreLock(taken.lock, file, env())).toBe(false)

    acquireStoreLock(file, env({ mintToken: () => "other" }))
    expect(renewStoreLock(taken.lock, file, env())).toBe(false)
  })

  it("releases its own lock and leaves someone else's alone", () => {
    const taken = acquireStoreLock(file, env())
    if (!taken.ok) throw new Error("expected lock")
    releaseStoreLock(taken.lock, file, env())
    expect(readStoreLock(file)).toBeNull()

    const other = acquireStoreLock(file, env({ mintToken: () => "other" }))
    if (!other.ok) throw new Error("expected lock")
    releaseStoreLock(taken.lock, file, env())
    expect(readStoreLock(file)?.token).toBe("other")
  })

  it("reads null for a store with no lock at all", () => {
    expect(readStoreLock(file)).toBeNull()
  })
})

describe("startStoreLockHeartbeat", () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it("renews on the cadence until stopped", () => {
    let clock = 1_000_000
    const holder = env({ now: () => clock })
    const taken = acquireStoreLock(file, holder)
    if (!taken.ok) throw new Error("expected lock")

    const stop = startStoreLockHeartbeat(taken.lock, file, holder, undefined, LEASE_HEARTBEAT_MS)
    clock += LEASE_HEARTBEAT_MS
    jest.advanceTimersByTime(LEASE_HEARTBEAT_MS)
    expect(readStoreLock(file)?.heartbeatAt).toBe(clock)

    stop()
    clock += LEASE_HEARTBEAT_MS
    jest.advanceTimersByTime(LEASE_HEARTBEAT_MS)
    expect(readStoreLock(file)?.heartbeatAt).toBe(clock - LEASE_HEARTBEAT_MS)
  })

  it("stops itself and notifies when the lock is lost", () => {
    const holder = env()
    const taken = acquireStoreLock(file, holder)
    if (!taken.ok) throw new Error("expected lock")
    const onLost = jest.fn()
    startStoreLockHeartbeat(taken.lock, file, holder, onLost, LEASE_HEARTBEAT_MS)

    fs.rmSync(storeLockPath(file))
    jest.advanceTimersByTime(LEASE_HEARTBEAT_MS)
    expect(onLost).toHaveBeenCalledTimes(1)

    jest.advanceTimersByTime(LEASE_HEARTBEAT_MS * 3)
    expect(onLost).toHaveBeenCalledTimes(1)
  })
})
