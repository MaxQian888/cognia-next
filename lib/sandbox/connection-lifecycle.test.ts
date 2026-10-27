import type { SandboxClient } from "@/lib/automation/sandbox-client"
import type { LumeClient, LumeResource } from "@/lib/automation/lume-client"
import type { SandboxConnectionRow } from "@/types/sandbox"
import {
  hasSandboxConnectionLifecycleAdapter,
  runSandboxConnectionOperation,
  serializeSandboxConnectionOperation,
} from "./connection-lifecycle"
import { defaultSandboxCapabilities, SANDBOX_CAPABILITY_REVISION } from "./connection-capabilities"
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
    capabilitiesRevision: SANDBOX_CAPABILITY_REVISION,
    lastHealthStatus: "unknown",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function fakeClient(overrides: Partial<SandboxClient> = {}): SandboxClient {
  return {
    create: jest.fn(async () => ({ containerId: "c1", port: 0 })),
    start: jest.fn(async () => ({ containerId: "c1", port: 49160 })),
    suspend: jest.fn(async () => undefined),
    resume: jest.fn(async () => ({ containerId: "c1", port: 49160 })),
    stop: jest.fn(async () => undefined),
    delete: jest.fn(async () => undefined),
    inspect: jest.fn(async () => ({
      containerId: "c1",
      status: "running",
      running: true,
      paused: false,
      networkMode: "bridge",
      nanoCpus: 0,
      memoryBytes: 0,
    })),
    health: jest.fn(async () => true),
    exec: jest.fn(async () => ({
      exitCode: 0,
      stdout: "container-host",
      stderr: "",
      durationMs: 4,
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
    })),
    readFile: jest.fn(async () => "file contents"),
    ...overrides,
  } as SandboxClient
}

describe("runSandboxConnectionOperation", () => {
  it("preserves the native Lume receipt and forwards the same cancellation signal", async () => {
    const signal = new AbortController().signal
    const resource: LumeResource = {
      resourceId: "owned",
      generation: 2,
      bootEpoch: "new-boot",
      connectionId: "conn-1",
      vmName: "owned",
      state: "running",
      readiness: { vm: true, ssh: true, helper: true, gui: true },
      quarantine: false,
      memoryMb: 8192,
      lastErrorCode: null,
      groupId: null,
    }
    const run = jest.fn().mockResolvedValue({ resource })
    const local = fakeClient()
    const connection = row({
      provider: "lume",
      driver: "cua-driver",
      state: "running",
      config: {
        provider: "lume",
        vmName: "owned",
        contractVersion: 1,
        resourceId: "owned",
        generation: 2,
        bootEpoch: "old-boot",
      },
      capabilities: defaultSandboxCapabilities("lume", "cua-driver"),
    })
    const outcome = await runSandboxConnectionOperation(connection, "connect", {
      client: local,
      lumeClient: { run } as unknown as LumeClient,
      signal,
    })
    expect(outcome.lume).toBe(resource)
    expect(run).toHaveBeenCalledWith(
      { kind: "connect", reference: { resourceId: "owned", generation: 2, bootEpoch: "old-boot" } },
      signal
    )
    expect(local.start).not.toHaveBeenCalled()
  })
  it("dispatches Docker lifecycle operations through the checked adapter", async () => {
    const client = fakeClient()
    await expect(runSandboxConnectionOperation(row(), "start", { client })).resolves.toMatchObject({
      containerId: "c1",
      port: 49160,
    })
    await expect(
      runSandboxConnectionOperation(row({ state: "running" }), "stop", { client })
    ).resolves.toEqual({})

    expect(client.start).toHaveBeenCalledWith("conn-1", "image", undefined)
    expect(client.stop).toHaveBeenCalledWith("conn-1")
  })

  it("deletes the container instead of merely stopping it", async () => {
    // The previous adapter implemented `delete` as `stop`, which only looked
    // correct because containers were created with `--rm`. Without `--rm` that
    // leaves the machine on disk forever, unreachable from a deleted row.
    const client = fakeClient()
    await runSandboxConnectionOperation(row({ state: "running" }), "delete", { client })
    expect(client.delete).toHaveBeenCalledWith("conn-1")
    expect(client.stop).not.toHaveBeenCalled()
  })

  it("suspends with pause rather than stop", async () => {
    // `docker stop` would lose the desktop session that suspend exists to keep.
    const client = fakeClient()
    await runSandboxConnectionOperation(row({ state: "running" }), "suspend", { client })
    expect(client.suspend).toHaveBeenCalledWith("conn-1")
    expect(client.stop).not.toHaveBeenCalled()
    expect(client.delete).not.toHaveBeenCalled()
  })

  it("resumes a suspended machine", async () => {
    const client = fakeClient()
    await expect(
      runSandboxConnectionOperation(row({ state: "suspended" }), "resume", { client })
    ).resolves.toMatchObject({ port: 49160 })
    expect(client.resume).toHaveBeenCalledWith("conn-1")
  })

  it("reports health from Docker's own state plus a live exec probe", async () => {
    const client = fakeClient()
    const result = await runSandboxConnectionOperation(row({ state: "running" }), "health", {
      client,
    })
    expect(result.health).toBe(true)
    expect(result.healthReport).toMatchObject({ reachable: true, state: "running" })
    expect(result.containerState).toMatchObject({ containerId: "c1", running: true })
    expect(client.inspect).toHaveBeenCalledWith("conn-1")
    expect(client.health).toHaveBeenCalledWith("conn-1")
  })

  it("calls a running container unreachable when the exec channel is dead", async () => {
    const client = fakeClient({ health: jest.fn(async () => false) })
    const result = await runSandboxConnectionOperation(row({ state: "running" }), "health", {
      client,
    })
    expect(result.health).toBe(false)
    expect(result.healthReport).toMatchObject({ reachable: false, state: "running" })
  })

  it("does not probe exec on a paused container, and reports it suspended", async () => {
    const client = fakeClient({
      inspect: jest.fn(async () => ({
        containerId: "c1",
        status: "paused",
        running: true,
        paused: true,
        networkMode: "bridge",
        nanoCpus: 0,
        memoryBytes: 0,
      })),
    })
    const result = await runSandboxConnectionOperation(row({ state: "running" }), "health", {
      client,
    })
    expect(result.healthReport).toMatchObject({ reachable: false, state: "suspended" })
    expect(client.health).not.toHaveBeenCalled()
  })

  it("reports an absent container as uninitialized rather than stopped", async () => {
    const client = fakeClient({ inspect: jest.fn(async () => null) })
    const result = await runSandboxConnectionOperation(row({ state: "running" }), "health", {
      client,
    })
    expect(result.healthReport).toMatchObject({ reachable: false, state: "uninitialized" })
    expect(result.containerState).toBeNull()
  })

  it("carries the frozen container policy into create and start", async () => {
    const client = fakeClient()
    const confined = row({
      config: {
        provider: "docker",
        image: "image",
        host: "127.0.0.1",
        port: 0,
        networkMode: "none",
        cpus: "1.5",
        memoryMb: 2048,
        workspaceMount: { hostPath: "/host/ws", containerPath: "/workspace" },
      },
    })
    await runSandboxConnectionOperation(confined, "create", { client })
    expect(client.create).toHaveBeenCalledWith("conn-1", "image", {
      networkMode: "none",
      cpus: "1.5",
      memoryMb: 2048,
      workspaceHostPath: "/host/ws",
      workspaceContainerPath: "/workspace",
    })
  })

  it("refuses providers without a real adapter before touching Docker", async () => {
    const client = fakeClient()
    const cloud = row({
      provider: "cua-cloud",
      config: { provider: "cua-cloud", instanceName: "desk", host: "example.com", port: 443 },
      capabilities: defaultSandboxCapabilities("cua-cloud", "computer-server"),
    })
    await expect(runSandboxConnectionOperation(cloud, "start", { client })).rejects.toMatchObject<
      Partial<SandboxCapabilityError>
    >({
      code: "not-implemented",
      operation: "start",
    })
    expect(client.start).not.toHaveBeenCalled()
    expect(client.stop).not.toHaveBeenCalled()
  })

  it("runs workspaceExec inside the machine", async () => {
    const client = fakeClient()
    const result = await runSandboxConnectionOperation(row({ state: "running" }), "workspaceExec", {
      client,
      exec: { argv: ["hostname"] },
    })
    expect(client.exec).toHaveBeenCalledWith("conn-1", {
      argv: ["hostname"],
      cwd: undefined,
      env: undefined,
      stdin: undefined,
      timeoutMs: undefined,
    })
    expect(result.exec).toMatchObject({ exitCode: 0, stdout: "container-host" })
  })

  it("refuses workspaceExec when the container cannot attest the requested policy", async () => {
    // Docker froze the container's network mode at create time and `docker
    // exec` cannot tighten it, so running this would execute with network
    // access the caller believes it gave up.
    const client = fakeClient()
    await expect(
      runSandboxConnectionOperation(row({ state: "running" }), "workspaceExec", {
        client,
        exec: {
          argv: ["curl", "https://example.com"],
          policy: {
            writable: [],
            readable: [],
            targetFiles: [],
            maxCpuSeconds: 0,
            maxMemoryMb: 0,
            network: "off",
            networkHosts: [],
          },
        },
      })
    ).rejects.toMatchObject({ code: "policy-not-attested" })
    expect(client.exec).not.toHaveBeenCalled()
  })

  it("refuses a workspace read outside the mounted directory", async () => {
    const client = fakeClient()
    const mounted = row({
      state: "running",
      config: {
        provider: "docker",
        image: "image",
        host: "127.0.0.1",
        port: 1,
        workspaceMount: { hostPath: "/host/ws", containerPath: "/workspace" },
      },
    })
    await expect(
      runSandboxConnectionOperation(mounted, "workspaceRead", { client, path: "/etc/passwd" })
    ).rejects.toMatchObject({ code: "workspace-boundary" })
    expect(client.readFile).not.toHaveBeenCalled()
  })

  it("rebases a workspace read onto the container mount", async () => {
    const client = fakeClient()
    const mounted = row({
      state: "running",
      config: {
        provider: "docker",
        image: "image",
        host: "127.0.0.1",
        port: 1,
        workspaceMount: { hostPath: "/host/ws", containerPath: "/workspace" },
      },
    })
    await runSandboxConnectionOperation(mounted, "workspaceRead", {
      client,
      path: "/host/ws/src/a.ts",
    })
    expect(client.readFile).toHaveBeenCalledWith("conn-1", "/workspace/src/a.ts")
  })
})

describe("hasSandboxConnectionLifecycleAdapter", () => {
  it("accepts only the implemented Docker/computer-server/config tuple", () => {
    expect(hasSandboxConnectionLifecycleAdapter(row())).toBe(true)
    expect(
      hasSandboxConnectionLifecycleAdapter(
        row({
          provider: "cua-cloud",
          config: { provider: "cua-cloud", instanceName: "desk" },
        })
      )
    ).toBe(false)
    expect(hasSandboxConnectionLifecycleAdapter(row({ driver: "cua-driver" }))).toBe(false)
    expect(
      hasSandboxConnectionLifecycleAdapter(row({ config: { provider: "lume", vmName: "compat" } }))
    ).toBe(false)
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

it("connects E2B through its explicit Host and returns a cloud outcome without Docker placement", async () => {
  const local = fakeClient()
  const resource = {
    id: "desktop",
    generation: 1,
    state: "running" as const,
    providerConfigId: "byo",
    deadlineAt: 100,
    idleTimeoutSeconds: 600,
    createdAt: 1,
    updatedAt: 1,
    cleanupAttempts: 0,
    qualification: "unqualified" as const,
  }
  const connect = jest.fn().mockResolvedValue(resource)
  const cloud = row({
    provider: "e2b",
    config: {
      provider: "e2b",
      target: { kind: "remote", hostId: "selected-host" },
      providerConfigId: "byo",
      desktopId: "desktop",
      generation: 1,
      qualification: "unqualified",
    },
    capabilities: defaultSandboxCapabilities("e2b", "computer-server"),
  })
  await expect(
    runSandboxConnectionOperation(cloud, "connect", {
      client: local,
      managedClient: {
        connect,
      } as unknown as import("@/lib/automation/managed-desktop-client").ManagedDesktopClient,
    })
  ).resolves.toEqual({ managedDesktop: resource })
  expect(connect).toHaveBeenCalledWith(
    { kind: "remote", hostId: "selected-host" },
    { desktopId: "desktop", generation: 1 }
  )
  expect(local.start).not.toHaveBeenCalled()
})
