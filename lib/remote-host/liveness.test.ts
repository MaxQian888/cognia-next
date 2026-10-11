/** @jest-environment jsdom */

import type { RemoteHostTarget } from "@/lib/remote-host/target-transport"
import type { Transport } from "@/lib/tauri/transport-types"
import { useRemoteHostStore, type RemoteHost } from "@/stores/remote-host/remote-host-store"

import { __resetManagementChannelsForTests } from "./management-channel"
import {
  HOST_LIVENESS_INTERVAL_MS,
  HOST_LIVENESS_MAX_BACKOFF_MS,
  hostsToProbe,
  nextProbeDelay,
  probeHostLiveness,
  startHostLivenessLoop,
} from "./liveness"

const NOW = 1_800_000_000_000

function manifest(hostBuildId = "1.0.0") {
  return {
    schemaVersion: 2,
    hostBuildId,
    platform: "headless",
    generatedAt: NOW,
    hostIdentity: { id: "stable-1", kind: "cloud" },
    protocol: { min: 1, max: 2 },
    operations: [],
    deviceGrants: [],
    features: {},
    limits: {
      rpcJsonBodyBytes: 1,
      skillMaxResources: 1,
      skillMaxResourceBytes: 1,
      skillUploadChunkBytes: 1,
      mcpRequestBodyBytes: 1,
      maxConcurrentProxyCalls: 1,
    },
  }
}

function host(overrides: Partial<RemoteHost> = {}): RemoteHost {
  return {
    id: "h1",
    label: "Mac mini",
    credentialRef: "remote-host:h1",
    addedAt: 1,
    connectionState: "disconnected",
    alwaysOn: true,
    config: { baseUrl: "https://mini.local", serverVersion: "1.0.0", deviceId: "dev-1" },
    ...overrides,
  }
}

function channelAnswering(call: Transport["call"]) {
  const transport: Transport = { call, subscribe: jest.fn(() => () => undefined) }
  return {
    openTarget: jest.fn(
      async () => ({ host: host(), transport, close: jest.fn() }) as RemoteHostTarget
    ),
  }
}

beforeEach(() => {
  __resetManagementChannelsForTests()
  useRemoteHostStore.setState({ hosts: [host()], activeHostId: null })
})

describe("probeHostLiveness", () => {
  it("records a version-matched manifest as the host being alive", async () => {
    const call = jest.fn(async () => manifest()) as unknown as Transport["call"]
    const result = await probeHostLiveness("h1", {
      channel: channelAnswering(call),
      now: () => NOW,
    })
    expect(call).toHaveBeenCalledWith("host_feature_manifest", {})
    expect(result).toEqual({ at: NOW, ok: true })
    expect(useRemoteHostStore.getState().hosts[0]).toMatchObject({
      lastConnectedAt: NOW,
      featureManifestAt: NOW,
      lastProbe: { ok: true },
    })
  })

  it("records a host that does not answer in time as a miss", async () => {
    const call = jest.fn(() => new Promise(() => undefined)) as unknown as Transport["call"]
    const result = await probeHostLiveness("h1", {
      channel: channelAnswering(call),
      now: () => NOW,
      timeoutMs: 5,
    })
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("did not answer") })
    expect(useRemoteHostStore.getState().hosts[0]?.lastConnectedAt).toBeUndefined()
  })

  it("records a channel that cannot open as a miss, verbatim", async () => {
    const result = await probeHostLiveness("h1", {
      channel: { openTarget: jest.fn(async () => Promise.reject(new Error("no route"))) },
      now: () => NOW,
    })
    expect(result).toEqual({ at: NOW, ok: false, error: "no route" })
  })
})

describe("hostsToProbe", () => {
  it("skips the routed host and revoked ones", () => {
    const hosts = [
      host({ id: "a" }),
      host({ id: "b" }),
      host({ id: "c", connectionState: "revoked" }),
    ]
    expect(hostsToProbe({ hosts, activeHostId: "b" }).map((h) => h.id)).toEqual(["a"])
  })
})

describe("nextProbeDelay", () => {
  it("probes every minute while answered, and backs off to a ceiling when not", () => {
    expect(nextProbeDelay(0)).toBe(HOST_LIVENESS_INTERVAL_MS)
    expect(nextProbeDelay(1)).toBe(HOST_LIVENESS_INTERVAL_MS * 2)
    expect(nextProbeDelay(2)).toBe(HOST_LIVENESS_INTERVAL_MS * 4)
    expect(nextProbeDelay(20)).toBe(HOST_LIVENESS_MAX_BACKOFF_MS)
  })
})

describe("startHostLivenessLoop", () => {
  function manual() {
    let tick: () => void = () => undefined
    return {
      setInterval: (fn: () => void) => {
        tick = fn
        return 1
      },
      clearInterval: jest.fn(),
      tick: () => tick(),
    }
  }

  const flush = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  }

  it("probes a host at once, then again only when it is due", async () => {
    let now = NOW
    const timer = manual()
    const probe = jest.fn(async () => ({ at: now, ok: true }))
    const stop = startHostLivenessLoop({ probe, now: () => now, ...timer })
    await flush()
    expect(probe).toHaveBeenCalledTimes(1)

    timer.tick()
    await flush()
    expect(probe).toHaveBeenCalledTimes(1)

    now += HOST_LIVENESS_INTERVAL_MS
    timer.tick()
    await flush()
    expect(probe).toHaveBeenCalledTimes(2)
    stop()
    expect(timer.clearInterval).toHaveBeenCalled()
  })

  it("backs off a host that keeps missing", async () => {
    let now = NOW
    const timer = manual()
    const probe = jest.fn(async () => ({ at: now, ok: false, error: "no route" }))
    startHostLivenessLoop({ probe, now: () => now, ...timer })
    await flush()
    now += HOST_LIVENESS_INTERVAL_MS
    timer.tick()
    await flush()
    // One miss doubles the wait, so a minute later it is not due yet.
    expect(probe).toHaveBeenCalledTimes(1)
    now += HOST_LIVENESS_INTERVAL_MS
    timer.tick()
    await flush()
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it("never runs two probes of one host at once", async () => {
    let now = NOW
    const timer = manual()
    const probe = jest.fn(() => new Promise<null>(() => undefined))
    startHostLivenessLoop({ probe, now: () => now, ...timer })
    now += 10 * HOST_LIVENESS_INTERVAL_MS
    timer.tick()
    await flush()
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it("does not probe the host the desktop is routing to", async () => {
    useRemoteHostStore.setState({ hosts: [host()], activeHostId: "h1" })
    const probe = jest.fn()
    startHostLivenessLoop({ probe, now: () => NOW, ...manual() })
    await flush()
    expect(probe).not.toHaveBeenCalled()
  })
})
