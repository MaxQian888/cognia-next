import { buildDeviceRuntime, buildLocalShellTiers } from "./device-runtime"
import type { LocalDeviceInput } from "./types"
import type { SandboxConnectionRow } from "@/types/sandbox"

const LOCAL: LocalDeviceInput = {
  ref: "local",
  label: "This Mac",
  platform: "tauri",
  appVersion: "1.0.0",
  capabilities: ["shell", "pty"],
  microvmAvailable: true,
  osSandboxAvailable: true,
}

const CONNECTION = {
  id: "conn-1",
  name: "docker",
  provider: "docker",
  driver: "computer-server",
  config: { provider: "docker", image: "img", host: "127.0.0.1", port: 1 },
  state: "running",
  capabilities: {
    create: true,
    connect: true,
    start: true,
    suspend: false,
    resume: false,
    stop: true,
    delete: true,
    health: true,
    gui: true,
    workspaceRead: false,
    workspaceExec: false,
  },
  lastHealthStatus: "ok",
  createdAt: 1,
  updatedAt: 2,
} as unknown as SandboxConnectionRow

describe("buildLocalShellTiers", () => {
  it("lists cua-desktop unavailable when no connection carries workspace execution", () => {
    // Listed, not hidden: a session still holding the stored tier needs to see
    // why it refuses.
    const tiers = buildLocalShellTiers(LOCAL, [CONNECTION])
    expect(tiers.find((tier) => tier.tier === "cua-desktop")).toEqual({
      tier: "cua-desktop",
      available: false,
      reasonKey: "cuaDesktopNoConnection",
    })
  })

  it("makes cua-desktop available once a connection carries workspace execution", () => {
    // The withdrawal reason was that a bound desktop proved GUI isolation
    // only. `docker exec` runs inside the container, so the reason no longer
    // holds for a Docker connection that advertises the capability.
    const capable = {
      ...CONNECTION,
      capabilities: { ...CONNECTION.capabilities, workspaceRead: true, workspaceExec: true },
    } as SandboxConnectionRow
    expect(buildLocalShellTiers(LOCAL, [capable]).find((t) => t.tier === "cua-desktop")).toEqual({
      tier: "cua-desktop",
      available: true,
      reasonKey: undefined,
    })
  })

  it("stays unavailable with no connections at all", () => {
    expect(buildLocalShellTiers(LOCAL).find((t) => t.tier === "cua-desktop")).toMatchObject({
      available: false,
      reasonKey: "cuaDesktopNoConnection",
    })
  })

  it("withholds the microVM tier when no adapter is registered", () => {
    const tiers = buildLocalShellTiers({ ...LOCAL, microvmAvailable: false })
    expect(tiers.find((tier) => tier.tier === "microvm")).toEqual({
      tier: "microvm",
      available: false,
      reasonKey: "microvmAdapterMissing",
    })
  })

  it("withholds the OS tier when the backend probe failed", () => {
    const tiers = buildLocalShellTiers({ ...LOCAL, osSandboxAvailable: false })
    expect(tiers.find((tier) => tier.tier === "os")).toMatchObject({
      available: false,
      reasonKey: "osBackendUnavailable",
    })
  })
})

describe("buildDeviceRuntime — local", () => {
  it("owns the sandbox connections and its workspaces while routing locally", () => {
    const runtime = buildDeviceRuntime({
      kind: "local",
      local: LOCAL,
      sandboxConnections: [CONNECTION],
      activeHostId: null,
    })
    expect(runtime.sandbox.support).toBe("supported")
    expect(runtime.sandbox.connections).toEqual([CONNECTION])
    expect(runtime.workspaces).toEqual({ support: "supported" })
    expect(runtime.isRoutingTarget).toBe(true)
  })

  /**
   * `task_workspace_environment_list` is an `execution`-target command, so it
   * resolves to `activeRemote ?? local`. Rendering its result under the local
   * device while a Host is active would print the Host's worktrees as ours.
   */
  it("stops claiming workspaces once the transport routes to a remote host", () => {
    const runtime = buildDeviceRuntime({
      kind: "local",
      local: LOCAL,
      sandboxConnections: [CONNECTION],
      activeHostId: "host-1",
    })
    expect(runtime.workspaces).toEqual({
      support: "requires-activation",
      reasonKey: "routedToRemoteHost",
    })
    expect(runtime.isRoutingTarget).toBe(false)
  })

  it("keeps the sandbox connections local even while a host is active", () => {
    const runtime = buildDeviceRuntime({
      kind: "local",
      local: LOCAL,
      sandboxConnections: [CONNECTION],
      activeHostId: "host-1",
    })
    expect(runtime.sandbox.support).toBe("supported")
    expect(runtime.sandbox.connections).toEqual([CONNECTION])
  })
})

describe("buildDeviceRuntime — remote host", () => {
  it("reads workspaces only while it is the routing target", () => {
    const active = buildDeviceRuntime({
      kind: "remote-host",
      hostId: "host-1",
      local: LOCAL,
      sandboxConnections: [CONNECTION],
      activeHostId: "host-1",
    })
    expect(active.workspaces).toEqual({ support: "supported" })
    expect(active.isRoutingTarget).toBe(true)

    const idle = buildDeviceRuntime({
      kind: "remote-host",
      hostId: "host-2",
      local: LOCAL,
      sandboxConnections: [CONNECTION],
      activeHostId: "host-1",
    })
    expect(idle.workspaces).toEqual({
      support: "requires-activation",
      reasonKey: "activateToInspect",
    })
    expect(idle.isRoutingTarget).toBe(false)
  })

  it("never inherits this machine's sandbox connections", () => {
    const runtime = buildDeviceRuntime({
      kind: "remote-host",
      hostId: "host-1",
      local: LOCAL,
      sandboxConnections: [CONNECTION],
      activeHostId: "host-1",
    })
    expect(runtime.sandbox).toEqual({
      support: "unsupported",
      reasonKey: "sandboxIsClientLocal",
      connections: [],
    })
  })

  it("admits it cannot know a host's shell tiers", () => {
    const runtime = buildDeviceRuntime({
      kind: "remote-host",
      hostId: "host-1",
      local: LOCAL,
      sandboxConnections: [],
      activeHostId: "host-1",
    })
    expect(runtime.shellTiers).toEqual([])
  })
})

describe("buildDeviceRuntime — devices that host nothing", () => {
  it.each(["paired-device", "worker"] as const)("refuses both surfaces for %s", (kind) => {
    const runtime = buildDeviceRuntime({
      kind,
      local: LOCAL,
      sandboxConnections: [CONNECTION],
      activeHostId: null,
    })
    expect(runtime.sandbox.support).toBe("unsupported")
    expect(runtime.sandbox.connections).toEqual([])
    expect(runtime.workspaces.support).toBe("unsupported")
    expect(runtime.workspaces.reasonKey).toBeDefined()
    expect(runtime.shellTiers).toEqual([])
    expect(runtime.isRoutingTarget).toBe(false)
  })

  it("names a different reason for a phone than for a worker", () => {
    const phone = buildDeviceRuntime({
      kind: "paired-device",
      local: LOCAL,
      sandboxConnections: [],
      activeHostId: null,
    })
    const worker = buildDeviceRuntime({
      kind: "worker",
      local: LOCAL,
      sandboxConnections: [],
      activeHostId: null,
    })
    expect(phone.workspaces.reasonKey).toBe("workspaceNotHosted")
    expect(worker.workspaces.reasonKey).toBe("workerNoRoutingPlane")
  })
})
