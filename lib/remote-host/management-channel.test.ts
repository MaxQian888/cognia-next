/** @jest-environment jsdom */

import type { RemoteHostTarget } from "@/lib/remote-host/target-transport"
import type { Transport } from "@/lib/tauri/transport-types"
import { useRemoteHostStore, type RemoteHost } from "@/stores/remote-host/remote-host-store"

import {
  __resetManagementChannelsForTests,
  acquireManagementChannel,
  closeManagementChannel,
  closeStaleManagementChannels,
  managementChannelKey,
  MANAGEMENT_CHANNEL_IDLE_MS,
  openManagementChannels,
  withManagementChannel,
} from "./management-channel"

function host(overrides: Partial<RemoteHost> = {}): RemoteHost {
  return {
    id: "h1",
    label: "Mac mini",
    credentialRef: "remote-host:h1",
    addedAt: 1,
    connectionState: "disconnected",
    config: { baseUrl: "https://mini.local", serverVersion: "1.0.0", deviceId: "dev-1" },
    ...overrides,
  }
}

function target(hostRow: RemoteHost = host()) {
  const close = jest.fn()
  const transport: Transport = { call: jest.fn(), subscribe: jest.fn(() => () => undefined) }
  return { value: { host: hostRow, transport, close } as RemoteHostTarget, close }
}

/** Timers driven by hand, so the idle close is observable without waiting. */
function timers() {
  const pending = new Map<number, () => void>()
  let next = 1
  return {
    setTimer: (fn: () => void) => {
      const id = next++
      pending.set(id, fn)
      return id
    },
    clearTimer: (id: unknown) => {
      pending.delete(id as number)
    },
    fireAll: () => {
      for (const [id, fn] of [...pending]) {
        pending.delete(id)
        fn()
      }
    },
    count: () => pending.size,
  }
}

beforeEach(() => {
  __resetManagementChannelsForTests()
  useRemoteHostStore.setState({ hosts: [host()], activeHostId: null })
})

it("opens one connection per host and shares it between leases", async () => {
  const t = target()
  const openTarget = jest.fn(async () => t.value)
  const clock = timers()
  const deps = { openTarget, ...clock }

  const a = await acquireManagementChannel("h1", deps)
  const b = await acquireManagementChannel("h1", deps)
  expect(openTarget).toHaveBeenCalledTimes(1)
  expect(a.transport).toBe(b.transport)

  a.release()
  expect(clock.count()).toBe(0)
  b.release()
  // The last release only starts the idle timer; the channel stays warm.
  expect(clock.count()).toBe(1)
  expect(t.close).not.toHaveBeenCalled()
  clock.fireAll()
  await Promise.resolve()
  expect(t.close).toHaveBeenCalledTimes(1)
  expect(openManagementChannels()).toEqual([])
})

it("keeps a warm channel when it is leased again before the idle timer fires", async () => {
  const t = target()
  const openTarget = jest.fn(async () => t.value)
  const clock = timers()
  const deps = { openTarget, ...clock }
  ;(await acquireManagementChannel("h1", deps)).release()
  const again = await acquireManagementChannel("h1", deps)
  expect(clock.count()).toBe(0)
  expect(openTarget).toHaveBeenCalledTimes(1)
  again.release()
  again.release() // idempotent
  expect(clock.count()).toBe(1)
})

it("names one channel whichever way the host is referred to", async () => {
  useRemoteHostStore.setState({
    hosts: [
      host({
        featureManifest: {
          schemaVersion: 2,
          hostIdentity: { id: "stable-1", kind: "cloud" },
        } as RemoteHost["featureManifest"],
      }),
    ],
  })
  expect(managementChannelKey("stable-1")).toBe("h1")
  expect(managementChannelKey("unknown")).toBe("unknown")
  const openTarget = jest.fn(async () => target().value)
  await acquireManagementChannel("stable-1", { openTarget })
  await acquireManagementChannel("h1", { openTarget })
  expect(openTarget).toHaveBeenCalledTimes(1)
})

it("does not cache a failed open, so the next lease tries again", async () => {
  const openTarget = jest
    .fn()
    .mockRejectedValueOnce(new Error("credential is unavailable"))
    .mockResolvedValueOnce(target().value)
  await expect(acquireManagementChannel("h1", { openTarget })).rejects.toThrow(
    "credential is unavailable"
  )
  await expect(acquireManagementChannel("h1", { openTarget })).resolves.toBeDefined()
  expect(openTarget).toHaveBeenCalledTimes(2)
})

it("closes a channel at once when asked, whatever holds it", async () => {
  const t = target()
  await acquireManagementChannel("h1", { openTarget: async () => t.value })
  closeManagementChannel("h1")
  await Promise.resolve()
  expect(t.close).toHaveBeenCalled()
  expect(openManagementChannels()).toEqual([])
})

it("refuses a lease whose channel was closed while it was opening", async () => {
  let resolve: (value: RemoteHostTarget) => void = () => undefined
  const opening = new Promise<RemoteHostTarget>((r) => {
    resolve = r
  })
  const lease = acquireManagementChannel("h1", { openTarget: () => opening })
  closeManagementChannel("h1")
  resolve(target().value)
  await expect(lease).rejects.toThrow("was closed")
})

/**
 * A re-pair replaces the device id and keys. A connection built from the old
 * ones is refused as unauthorized, which a liveness probe would record as a
 * revocation of a perfectly good pairing.
 */
it("reopens a channel whose host was re-paired or removed since it opened", async () => {
  const first = target()
  const second = target(host({ config: { ...host().config, deviceId: "dev-2" } }))
  const openTarget = jest
    .fn()
    .mockResolvedValueOnce(first.value)
    .mockResolvedValueOnce(second.value)
  ;(await acquireManagementChannel("h1", { openTarget })).release()
  await Promise.resolve()

  useRemoteHostStore.setState({
    hosts: [host({ config: { ...host().config, deviceId: "dev-2" } })],
  })
  const lease = await acquireManagementChannel("h1", { openTarget })
  expect(openTarget).toHaveBeenCalledTimes(2)
  expect(first.close).toHaveBeenCalled()
  expect(lease.transport).toBe(second.value.transport)

  useRemoteHostStore.setState({ hosts: [] })
  closeStaleManagementChannels()
  await Promise.resolve()
  expect(second.close).toHaveBeenCalled()
})

it("gives the lease back after one piece of work, even when it fails", async () => {
  const clock = timers()
  const deps = { openTarget: async () => target().value, ...clock }
  await expect(
    withManagementChannel("h1", async () => Promise.reject(new Error("refused")), deps)
  ).rejects.toThrow("refused")
  expect(clock.count()).toBe(1)
})

it("stays open longer than a liveness interval", () => {
  expect(MANAGEMENT_CHANNEL_IDLE_MS).toBeGreaterThan(60_000)
})
