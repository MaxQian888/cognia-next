import type { SandboxPlacement } from "@/types/sandbox/environment-spec"
import type { Transport } from "@/lib/tauri/transport-types"
import { setActiveRemoteTransport, __resetRoutingForTests } from "@/lib/tauri/transport-routing"
import {
  __resetSpawnPlacementsForTests,
  clearSpawnPlacement,
  registerSpawnPlacement,
  spawnedPlacementDigest,
} from "@/lib/sandbox/spawn-placement-registry"
import { __resetAgentProcessHostsForTests } from "../agent-transport"
import {
  createAgentTransportProcessHost,
  createProcessPlaneHost,
  type ProcessPlane,
} from "./process-host"

function recordingPlane() {
  const listeners = new Map<string, (payload: unknown) => void>()
  const invoke = jest.fn(async (_name: string, _args: Record<string, unknown>) => undefined)
  const plane: ProcessPlane = {
    invoke: invoke as ProcessPlane["invoke"],
    listen: (async (event: string, callback: (payload: unknown) => void) => {
      listeners.set(event, callback)
      return () => listeners.delete(event)
    }) as ProcessPlane["listen"],
  }
  return { plane, invoke, listeners }
}

describe("createProcessPlaneHost", () => {
  it("maps the typed port onto the external-agent process plane commands", async () => {
    const { plane, invoke } = recordingPlane()
    const host = createProcessPlaneHost(plane, () => true)
    await host.spawn({ id: "a1", command: "agent", args: ["--rpc"], cwd: "/w", framing: "raw" })
    await host.send("a1", "{}\n")
    await host.kill("a1")
    expect(invoke.mock.calls).toEqual([
      [
        "spawn_external_agent",
        { config: { id: "a1", command: "agent", args: ["--rpc"], cwd: "/w", framing: "raw" } },
      ],
      ["send_to_external_agent", { agentId: "a1", message: "{}\n" }],
      ["kill_external_agent", { agentId: "a1" }],
    ])
  })

  it("probes commands through the plane and reads only a literal true as present", async () => {
    const { plane, invoke } = recordingPlane()
    const host = createProcessPlaneHost(plane, () => true)
    invoke.mockResolvedValueOnce(true as never)
    await expect(host.commandExists("aider")).resolves.toBe(true)
    invoke.mockResolvedValueOnce("yes" as never)
    await expect(host.commandExists("aider")).resolves.toBe(false)
    expect(invoke).toHaveBeenCalledWith("check_command_exists", { command: "aider" })
  })

  it("resolves with the id the host registered, defaulting to the requested one", async () => {
    const { plane, invoke } = recordingPlane()
    const host = createProcessPlaneHost(plane, () => true)
    await expect(host.spawn({ id: "a1", command: "agent" })).resolves.toBe("a1")
    invoke.mockResolvedValueOnce("host-assigned" as never)
    await expect(host.spawn({ id: "a1", command: "agent" })).resolves.toBe("host-assigned")
  })

  it("does not invent spawn fields the caller left out", async () => {
    const { plane, invoke } = recordingPlane()
    await createProcessPlaneHost(plane, () => true).spawn({ id: "a1", command: "agent" })
    expect(invoke).toHaveBeenCalledWith("spawn_external_agent", {
      config: { id: "a1", command: "agent" },
    })
  })

  it("translates plane payloads to process events on every channel", async () => {
    const { plane, listeners } = recordingPlane()
    const host = createProcessPlaneHost(plane, () => true)
    const seen: unknown[] = []
    await host.onStdoutLine((e) => seen.push(["line", e]))
    await host.onStdoutRaw((e) => seen.push(["raw", e]))
    await host.onStderr((e) => seen.push(["err", e]))
    const off = await host.onExit((e) => seen.push(["exit", e]))
    listeners.get("external-agent://stdout")?.({ agentId: "a1", data: "hello" })
    listeners.get("external-agent://stdout-raw")?.({ agentId: "a1", data: "aGk=" })
    listeners.get("external-agent://stderr")?.({ agentId: "a1", data: "warn" })
    listeners.get("external-agent://exit")?.({ agentId: "a1", code: 3, signal: null })
    listeners.get("external-agent://exit")?.({ agentId: "a2", code: 0 })
    expect(seen).toEqual([
      ["line", { processId: "a1", data: "hello" }],
      ["raw", { processId: "a1", data: "aGk=" }],
      ["err", { processId: "a1", data: "warn" }],
      ["exit", { processId: "a1", code: 3, signal: null }],
      ["exit", { processId: "a2", code: 0 }],
    ])
    off()
    expect(listeners.has("external-agent://exit")).toBe(false)
  })

  it("re-reads availability on every access", () => {
    let available = false
    const host = createProcessPlaneHost(recordingPlane().plane, () => available)
    expect(host.available).toBe(false)
    available = true
    expect(host.available).toBe(true)
  })
})

describe("runtime-environment placement through the app process host", () => {
  const placement: SandboxPlacement = {
    kind: "container",
    isolationMandatory: true,
    spec: {
      version: 1,
      specDigest: "a".repeat(64),
      projectId: "project-dsh",
      source: { kind: "deployment-default", catalogEntryId: "default" },
      image: {
        registry: "ghcr.io",
        repository: "cognia/runner",
        digest: `sha256:${"b".repeat(64)}`,
      },
      bundle: { digest: `sha256:${"c".repeat(64)}`, releaseTag: "v1", pinned: false },
      isolation: { minimum: "container" },
      sizeClassId: "small",
      lifecycle: "persistent",
      user: {},
      containerEnv: {},
      lifecycleCommands: {},
      forwardPorts: [],
      egress: { tier: "off", presetIds: [], approvedDomains: [] },
      browserSidecar: false,
    },
  }

  afterEach(() => {
    __resetSpawnPlacementsForTests()
    __resetAgentProcessHostsForTests()
    __resetRoutingForTests()
  })

  function pairedHost() {
    const call = jest.fn(async (_name: string, _args: Record<string, unknown>) => undefined)
    setActiveRemoteTransport({ call, subscribe: () => () => {} } as unknown as Transport)
    return { host: createAgentTransportProcessHost(), call }
  }

  it.each(["agent-1", "agent-1:dsh:session-1"])(
    "carries the project's placement to the host for %s",
    async (processId) => {
      registerSpawnPlacement("agent-1", placement)
      const { host, call } = pairedHost()
      await host.spawn({ id: processId, command: "node", framing: "raw" })
      expect(call).toHaveBeenCalledWith("spawn_external_agent", {
        config: expect.objectContaining({ id: processId, sandbox: placement }),
      })
      expect(spawnedPlacementDigest(processId)).toBe(placement.spec.specDigest)
    }
  )

  it("uses the current placement on reconnect and clears it when the project opts out", async () => {
    for (const current of [
      placement,
      { ...placement, spec: { ...placement.spec, specDigest: "d".repeat(64) } },
      undefined,
    ]) {
      if (current) registerSpawnPlacement("agent-1", current)
      else clearSpawnPlacement("agent-1")
      const { host, call } = pairedHost()
      await host.spawn({ id: "agent-1", command: "node" })
      const spawn = call.mock.calls.find(([name]) => name === "spawn_external_agent")![1]
      expect((spawn.config as { sandbox?: SandboxPlacement }).sandbox).toEqual(current)
      expect(spawnedPlacementDigest("agent-1")).toBe(current?.spec.specDigest ?? null)
      __resetAgentProcessHostsForTests()
    }
  })

  it("keeps unselected runs on the existing process path", async () => {
    const { host, call } = pairedHost()
    await host.spawn({ id: "agent-1", command: "node" })
    const spawn = call.mock.calls.find(([name]) => name === "spawn_external_agent")![1]
    expect(spawn.config).not.toHaveProperty("sandbox")
  })
})
