/** @jest-environment jsdom */
jest.mock("@/lib/tauri/transport-companion", () => ({ loadCompanionConfig: () => mockConfig }))
jest.mock("@/lib/runtime/runtime-target-context", () => ({
  getActiveRuntimeTargetContext: () => mockActive,
  subscribeRuntimeTargetContext: () => () => undefined,
}))

import {
  drivenPairedHostId,
  followRemoteHostKeys,
  refreshRemoteHostKeys,
} from "./remote-host-keys-follower"
import {
  __resetRuntimeSnapshotForTesting,
  setRuntimeSnapshot,
} from "@/lib/runtime/runtime-snapshot-store"
import {
  remoteHostKeyedProviders,
  remoteHostKeysHostId,
  resetRemoteHostKeysForTests,
  setRemoteHostKeyedProviders,
} from "./remote-host-keys"

let mockConfig: { targetId?: string } | null = null
let mockActive: { accountId: string; targetId: string } | null = null

afterEach(() => {
  resetRemoteHostKeysForTests()
  __resetRuntimeSnapshotForTesting()
  mockConfig = null
  mockActive = null
})

function controllable() {
  let onChange: () => void = () => undefined
  const subscribe = jest.fn((listener: () => void) => {
    onChange = listener
    return jest.fn()
  })
  return { subscribe, fire: () => onChange() }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("drivenPairedHostId", () => {
  it("names the companion target the app is routed to, and nothing else", () => {
    expect(drivenPairedHostId()).toBeNull()
    mockConfig = { targetId: "host-1" }
    expect(drivenPairedHostId()).toBeNull()
    mockActive = { accountId: "acc", targetId: "host-2" }
    expect(drivenPairedHostId()).toBeNull()
    mockActive = { accountId: "acc", targetId: "host-1" }
    expect(drivenPairedHostId()).toBe("host-1")
  })
})

describe("followRemoteHostKeys", () => {
  it("lists the driven Host's provider keys, re-reads on change, and forgets on stop", async () => {
    let host: string | null = "host-1"
    const listProviders = jest
      .fn()
      .mockResolvedValueOnce(["deepseek"])
      .mockResolvedValueOnce(["deepseek", "kimi"])
    const { subscribe, fire } = controllable()
    const follower = followRemoteHostKeys({ drivenHostId: () => host, listProviders, subscribe })
    await follower.ready
    expect([...remoteHostKeyedProviders()]).toEqual(["deepseek"])
    expect(listProviders).toHaveBeenCalledWith("host-1")

    fire()
    await settle()
    expect([...remoteHostKeyedProviders()].sort()).toEqual(["deepseek", "kimi"])

    host = null
    fire()
    await settle()
    expect(remoteHostKeyedProviders().size).toBe(0)

    setRemoteHostKeyedProviders("host-1", ["deepseek"])
    follower.stop()
    expect(remoteHostKeyedProviders().size).toBe(0)
  })

  it("keeps what it knew when a read for the same Host fails, and drops another Host's ids", async () => {
    const log = jest.fn()
    let host = "host-1"
    const listProviders = jest
      .fn()
      .mockResolvedValueOnce(["deepseek"])
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("forbidden"))
    const { subscribe, fire } = controllable()
    const follower = followRemoteHostKeys({
      drivenHostId: () => host,
      listProviders,
      subscribe,
      log,
    })
    await follower.ready

    fire()
    await settle()
    expect([...remoteHostKeyedProviders()]).toEqual(["deepseek"])
    expect(log).toHaveBeenCalledWith(expect.stringContaining("offline"))

    host = "host-2"
    fire()
    await settle()
    expect(remoteHostKeysHostId()).toBeNull()
    expect(remoteHostKeyedProviders().size).toBe(0)
    follower.stop()
  })

  it("lets a read that lands after a Host switch go", async () => {
    let host = "host-1"
    let finish: (ids: string[]) => void = () => undefined
    const listProviders = jest.fn(() => new Promise<string[]>((resolve) => (finish = resolve)))
    const follower = followRemoteHostKeys({
      drivenHostId: () => host,
      listProviders,
      subscribe: () => () => undefined,
    })
    await settle()
    host = "host-2"
    finish(["deepseek"])
    await follower.ready
    expect(remoteHostKeyedProviders().size).toBe(0)
    follower.stop()
  })

  it("re-reads when this device asks it to", async () => {
    mockConfig = { targetId: "host-1" }
    mockActive = { accountId: "acc", targetId: "host-1" }
    const listProviders = jest.fn().mockResolvedValue(["deepseek"])
    const follower = followRemoteHostKeys({ listProviders })
    await follower.ready
    refreshRemoteHostKeys()
    await settle()
    expect(listProviders).toHaveBeenCalledTimes(2)
    follower.stop()
  })

  it("waits for the Host's manifest, then asks only a device it lets list secrets", async () => {
    let gate: "ask" | "wait" | "lacks" = "wait"
    const listProviders = jest.fn().mockResolvedValue(["deepseek"])
    const { subscribe, fire } = controllable()
    const follower = followRemoteHostKeys({
      drivenHostId: () => "host-1",
      listProviders,
      access: () => gate,
      subscribe,
    })
    await follower.ready
    expect(listProviders).not.toHaveBeenCalled()

    gate = "ask"
    fire()
    await settle()
    expect([...remoteHostKeyedProviders()]).toEqual(["deepseek"])

    // The Host now says this device lacks the grant: nothing asked, nothing keyed.
    gate = "lacks"
    fire()
    await settle()
    expect(listProviders).toHaveBeenCalledTimes(1)
    expect(remoteHostKeyedProviders().size).toBe(0)
    follower.stop()
  })

  it("reads once the paired Host's manifest lands, and not on every snapshot change", async () => {
    const paired = {
      target: {
        id: "host-1",
        kind: "companion" as const,
        platform: "web" as const,
        hostKind: "cloud" as const,
      },
      vaultState: "unlocked" as const,
      connectionState: "connecting" as const,
    }
    setRuntimeSnapshot(paired)
    const listProviders = jest.fn().mockResolvedValue(["deepseek"])
    const follower = followRemoteHostKeys({ drivenHostId: () => "host-1", listProviders })
    await follower.ready
    expect(listProviders).not.toHaveBeenCalled()

    setRuntimeSnapshot({
      ...paired,
      host: { compatible: true, operations: [], grants: ["host.observe", "secret.manage"] },
    })
    await settle()
    expect(listProviders).toHaveBeenCalledTimes(1)
    setRuntimeSnapshot({
      ...paired,
      connectionState: "online",
      host: { compatible: true, operations: [], grants: ["host.observe", "secret.manage"] },
    })
    await settle()
    expect(listProviders).toHaveBeenCalledTimes(1)
    follower.stop()
  })
})
