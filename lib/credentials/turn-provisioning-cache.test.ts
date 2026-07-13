import { startTurnProvisioner } from "./turn-provisioning-cache"
import type { ProvisionResult } from "./turn-provisioning"
import type { TurnProviderConfig } from "@cognia/agent-config-types"

const PROVIDER: TurnProviderConfig = {
  kind: "cloudflare-calls",
  cloudflareKeyId: "k",
  secretRef: "kr:s",
}

/** Manual scheduler so tests drive timer fires deterministically. */
function scheduler() {
  const tasks: Array<{ id: number; fn: () => void; ms: number; cleared: boolean }> = []
  let nextId = 1
  return {
    tasks,
    setTimeoutImpl: ((fn: () => void, ms: number) => {
      const id = nextId++
      tasks.push({ id, fn, ms, cleared: false })
      return id as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout,
    clearTimeoutImpl: ((id: number) => {
      const t = tasks.find((x) => x.id === id)
      if (t) t.cleared = true
    }) as unknown as typeof clearTimeout,
    /** Fire the most recently scheduled, not-yet-cleared task. */
    async fireLast() {
      const t = [...tasks].reverse().find((x) => !x.cleared)
      if (t) {
        t.cleared = true
        t.fn()
        await Promise.resolve()
        await Promise.resolve()
      }
    },
  }
}

const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe("startTurnProvisioner", () => {
  it("provisions immediately and schedules a refresh at ~80% of the TTL", async () => {
    const sched = scheduler()
    const refreshed: RTCIceServer[][] = []
    const handle = startTurnProvisioner({
      provider: PROVIDER,
      onRefresh: (s) => refreshed.push(s),
      nowMs: () => 0,
      setTimeoutImpl: sched.setTimeoutImpl,
      clearTimeoutImpl: sched.clearTimeoutImpl,
      provisionImpl: async () => ({ iceServers: [{ urls: "turn:a" }], expiresAt: 10_000 }),
    })
    await flush()
    expect(handle.current()).toEqual([{ urls: "turn:a" }])
    expect(refreshed).toEqual([[{ urls: "turn:a" }]])
    const pending = sched.tasks.filter((t) => !t.cleared)
    expect(pending).toHaveLength(1)
    expect(pending[0].ms).toBe(8000) // max(1000, 10000 * 0.8)
    handle.stop()
  })

  it("re-provisions when the refresh timer fires", async () => {
    const sched = scheduler()
    const refreshed: RTCIceServer[][] = []
    let call = 0
    const handle = startTurnProvisioner({
      provider: PROVIDER,
      onRefresh: (s) => refreshed.push(s),
      nowMs: () => 0,
      setTimeoutImpl: sched.setTimeoutImpl,
      clearTimeoutImpl: sched.clearTimeoutImpl,
      provisionImpl: async (): Promise<ProvisionResult> => {
        call += 1
        return { iceServers: [{ urls: `turn:${call}` }], expiresAt: 10_000 }
      },
    })
    await flush()
    await sched.fireLast()
    expect(handle.current()).toEqual([{ urls: "turn:2" }])
    expect(refreshed).toEqual([[{ urls: "turn:1" }], [{ urls: "turn:2" }]])
    handle.stop()
  })

  it("keeps last-good credentials and retries with backoff on a provision error", async () => {
    const sched = scheduler()
    const refreshed: RTCIceServer[][] = []
    let call = 0
    const handle = startTurnProvisioner({
      provider: PROVIDER,
      onRefresh: (s) => refreshed.push(s),
      nowMs: () => 0,
      setTimeoutImpl: sched.setTimeoutImpl,
      clearTimeoutImpl: sched.clearTimeoutImpl,
      minBackoffMs: 5000,
      provisionImpl: async (): Promise<ProvisionResult> => {
        call += 1
        if (call === 1) return { iceServers: [{ urls: "turn:good" }], expiresAt: 10_000 }
        throw new Error("provider down")
      },
    })
    await flush()
    await sched.fireLast() // second call throws

    expect(handle.current()).toEqual([{ urls: "turn:good" }]) // last-good retained
    expect(refreshed).toEqual([[{ urls: "turn:good" }]]) // no onRefresh for the failure
    const pending = sched.tasks.filter((t) => !t.cleared)
    expect(pending[pending.length - 1].ms).toBe(5000) // backoff retry
    handle.stop()
  })

  it("returns [] and schedules a retry when the very first provision fails", async () => {
    const sched = scheduler()
    const refreshed: RTCIceServer[][] = []
    const handle = startTurnProvisioner({
      provider: PROVIDER,
      onRefresh: (s) => refreshed.push(s),
      nowMs: () => 0,
      setTimeoutImpl: sched.setTimeoutImpl,
      clearTimeoutImpl: sched.clearTimeoutImpl,
      minBackoffMs: 5000,
      provisionImpl: async () => {
        throw new Error("nope")
      },
    })
    await flush()
    expect(handle.current()).toEqual([])
    expect(refreshed).toEqual([])
    expect(sched.tasks.filter((t) => !t.cleared)[0].ms).toBe(5000)
    handle.stop()
  })

  it("stop() clears the pending timer and suppresses a late provision callback", async () => {
    const sched = scheduler()
    const refreshed: RTCIceServer[][] = []
    let resolveProvision: (r: ProvisionResult) => void = () => {}
    const handle = startTurnProvisioner({
      provider: PROVIDER,
      onRefresh: (s) => refreshed.push(s),
      nowMs: () => 0,
      setTimeoutImpl: sched.setTimeoutImpl,
      clearTimeoutImpl: sched.clearTimeoutImpl,
      provisionImpl: () =>
        new Promise<ProvisionResult>((resolve) => {
          resolveProvision = resolve
        }),
    })
    handle.stop()
    // The in-flight provision resolves AFTER stop — must be ignored.
    resolveProvision({ iceServers: [{ urls: "turn:late" }], expiresAt: 10_000 })
    await flush()
    expect(refreshed).toEqual([])
    expect(handle.current()).toEqual([])
  })
})
