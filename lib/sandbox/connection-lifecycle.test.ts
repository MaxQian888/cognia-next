import type { SandboxConnectionRow } from "@/types/sandbox"
import {
  runSandboxConnectionOperation,
  serializeSandboxConnectionOperation,
} from "./connection-lifecycle"
import { defaultSandboxCapabilities } from "./connection-capabilities"
import { SandboxCapabilityError } from "./lifecycle-contract"

function row(overrides: Partial<SandboxConnectionRow> = {}): SandboxConnectionRow {
  return {
    id: "conn-1",
    name: "desktop",
    provider: "docker",
    driver: "computer-server",
    config: { provider: "docker", image: "image", host: "127.0.0.1", port: 0 },
    state: "uninitialized",
    capabilities: defaultSandboxCapabilities("docker", "computer-server"),
    lastHealthStatus: "unknown",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe("runSandboxConnectionOperation", () => {
  const client = {
    start: jest.fn(async () => 49160),
    stop: jest.fn(async () => undefined),
    health: jest.fn(async () => true),
  }

  beforeEach(() => jest.clearAllMocks())

  it("dispatches Docker lifecycle operations through the checked adapter", async () => {
    await expect(runSandboxConnectionOperation(row(), "start", client)).resolves.toEqual({
      port: 49160,
    })
    await expect(
      runSandboxConnectionOperation(row({ state: "running" }), "health", client)
    ).resolves.toEqual({ health: true })
    await expect(
      runSandboxConnectionOperation(row({ state: "running" }), "stop", client)
    ).resolves.toEqual({})

    expect(client.start).toHaveBeenCalledWith("conn-1", "image")
    expect(client.health).toHaveBeenCalledWith("conn-1")
    expect(client.stop).toHaveBeenCalledWith("conn-1")
  })

  it("deletes through the existing stop/remove command", async () => {
    await runSandboxConnectionOperation(row(), "delete", client)
    expect(client.stop).toHaveBeenCalledWith("conn-1")
  })

  it("refuses providers without a real adapter before touching Docker", async () => {
    const cloud = row({
      provider: "cua-cloud",
      config: { provider: "cua-cloud", instanceName: "desk", host: "example.com", port: 443 },
      capabilities: defaultSandboxCapabilities("cua-cloud", "computer-server"),
    })
    await expect(runSandboxConnectionOperation(cloud, "start", client)).rejects.toMatchObject<
      Partial<SandboxCapabilityError>
    >({ code: "not-implemented", operation: "start" })
    expect(client.start).not.toHaveBeenCalled()
    expect(client.stop).not.toHaveBeenCalled()
  })
})

describe("serializeSandboxConnectionOperation", () => {
  it("serializes operations for one connection but releases the queue after failure", async () => {
    const events: string[] = []
    let releaseFirst!: () => void
    let markFirstStarted!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve
    })

    const first = serializeSandboxConnectionOperation("conn-1", async () => {
      events.push("first:start")
      markFirstStarted()
      await firstGate
      events.push("first:end")
      throw new Error("boom")
    })
    const second = serializeSandboxConnectionOperation("conn-1", async () => {
      events.push("second")
      return 2
    })

    await firstStarted
    expect(events).toEqual(["first:start"])
    releaseFirst()
    await expect(first).rejects.toThrow("boom")
    await expect(second).resolves.toBe(2)
    expect(events).toEqual(["first:start", "first:end", "second"])
  })
})
