/** @jest-environment jsdom */
const routing = { active: false }
jest.mock("@/lib/tauri/transport-routing", () => ({
  isRemoteHostActive: () => routing.active,
}))
const profileState = { value: "desktop" as string }
jest.mock("@/lib/platform/capabilities", () => ({
  ...jest.requireActual("@/lib/platform/capabilities"),
  detectHostProfile: () => profileState.value,
}))
const callMock = jest.fn()
jest.mock("@/lib/tauri", () => ({ transport: { call: (...a: unknown[]) => callMock(...a) } }))

import {
  __resetSchedulerHostTargetForTesting,
  __resetSchedulerTargetHostCacheForTesting,
  defaultSchedulerHostTarget,
  describeSchedulerTargetHost,
  getEffectiveSchedulerHostTarget,
  getPreferredSchedulerHostTarget,
  isPairedSchedulerHostAvailable,
  setPreferredSchedulerHostTarget,
  subscribeSchedulerHostTarget,
} from "./scheduler-host-target"

beforeEach(() => {
  __resetSchedulerHostTargetForTesting()
  __resetSchedulerTargetHostCacheForTesting()
  routing.active = false
  profileState.value = "desktop"
  callMock.mockReset()
})

describe("scheduler host target", () => {
  it("defaults to local on a plain desktop and paired on companions / while driving a remote host", () => {
    expect(isPairedSchedulerHostAvailable()).toBe(false)
    expect(defaultSchedulerHostTarget()).toBe("local")
    expect(getEffectiveSchedulerHostTarget()).toBe("local")
    routing.active = true
    expect(defaultSchedulerHostTarget()).toBe("paired")
    routing.active = false
    profileState.value = "cloud-companion"
    expect(getEffectiveSchedulerHostTarget()).toBe("paired")
    profileState.value = "mobile-companion"
    expect(getEffectiveSchedulerHostTarget()).toBe("paired")
    profileState.value = "web-standalone"
    expect(getEffectiveSchedulerHostTarget()).toBe("local")
  })

  it("remembers the preference in localStorage and notifies subscribers", () => {
    const listener = jest.fn()
    const unsubscribe = subscribeSchedulerHostTarget(listener)
    profileState.value = "cloud-companion"
    setPreferredSchedulerHostTarget("local")
    expect(listener).toHaveBeenCalledTimes(1)
    expect(getPreferredSchedulerHostTarget()).toBe("local")
    expect(getEffectiveSchedulerHostTarget()).toBe("local")
    expect(localStorage.getItem("cognia.scheduler.hostTarget.v1")).toBe("local")
    setPreferredSchedulerHostTarget(null)
    expect(localStorage.getItem("cognia.scheduler.hostTarget.v1")).toBeNull()
    expect(getEffectiveSchedulerHostTarget()).toBe("paired")
    unsubscribe()
    setPreferredSchedulerHostTarget("paired")
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it("degrades a remembered paired preference while no paired host is reachable", () => {
    setPreferredSchedulerHostTarget("paired")
    expect(getEffectiveSchedulerHostTarget()).toBe("local")
    routing.active = true
    expect(getEffectiveSchedulerHostTarget()).toBe("paired")
  })

  it("reads a stored preference on first access and ignores junk", () => {
    localStorage.setItem("cognia.scheduler.hostTarget.v1", "junk")
    __resetSchedulerHostTargetForTesting()
    localStorage.setItem("cognia.scheduler.hostTarget.v1", "junk")
    expect(getPreferredSchedulerHostTarget()).toBeNull()
    __resetSchedulerHostTargetForTesting()
    localStorage.setItem("cognia.scheduler.hostTarget.v1", "paired")
    expect(getPreferredSchedulerHostTarget()).toBe("paired")
  })
})

type RpcCall = <T>(name: string, args?: Record<string, unknown>) => Promise<T>
const rpc = (fn: jest.Mock) => fn as unknown as RpcCall

describe("describeSchedulerTargetHost", () => {
  it("returns the local descriptor for local and asks the paired host via host_capabilities", async () => {
    const local = await describeSchedulerTargetHost("local")
    expect(local.platform).toBe("web")
    const call = jest.fn(async () => ({ platform: "headless", capabilities: ["shell", "sidecar"] }))
    let now = 1_000
    const paired = await describeSchedulerTargetHost("paired", { call: rpc(call), now: () => now })
    expect(paired).toEqual({ platform: "headless", capabilities: ["shell", "sidecar"] })
    // Cached within the TTL, refreshed after it.
    await describeSchedulerTargetHost("paired", { call: rpc(call), now: () => now + 1_000 })
    expect(call).toHaveBeenCalledTimes(1)
    now += 120_000
    await describeSchedulerTargetHost("paired", { call: rpc(call), now: () => now })
    expect(call).toHaveBeenCalledTimes(2)
  })

  it("normalises unknown platforms and falls back to a server-backed guess on failure", async () => {
    const weird = jest.fn(async () => ({ platform: "mobile", capabilities: "nope" }))
    expect(await describeSchedulerTargetHost("paired", { call: rpc(weird) })).toEqual({
      platform: "headless",
      capabilities: [],
    })
    __resetSchedulerTargetHostCacheForTesting()
    const failing = jest.fn(async () => {
      throw new Error("offline")
    })
    const fallback = await describeSchedulerTargetHost("paired", { call: rpc(failing) })
    expect(fallback.platform).toBe("headless")
    expect(fallback.capabilities).toContain("sidecar")
    // Default `call` goes through the process transport.
    __resetSchedulerTargetHostCacheForTesting()
    callMock.mockResolvedValue({ platform: "tauri", capabilities: ["shell"] })
    expect(await describeSchedulerTargetHost("paired")).toEqual({
      platform: "tauri",
      capabilities: ["shell"],
    })
    expect(callMock).toHaveBeenCalledWith("host_capabilities", undefined)
  })
})
