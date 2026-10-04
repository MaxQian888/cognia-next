import type { ExternalAgentConfig } from "@/types/agent/external-agent"
import type { SandboxPlacement } from "@/types/sandbox/environment-spec"
import type { Transport } from "@/lib/tauri/transport-types"
import { setActiveRemoteTransport, __resetRoutingForTests } from "@/lib/tauri/transport-routing"
import {
  __resetSpawnPlacementsForTests,
  clearSpawnPlacement,
  registerSpawnPlacement,
  spawnedPlacementDigest,
} from "@/lib/sandbox/spawn-placement-registry"
import { agentInvoke, __resetAgentProcessHostsForTests } from "../../agent-transport"
import {
  createDshRuntimeTransport,
  resolveDshLaunchFromConfig,
  DshRuntimeUnavailableError,
  type DshProcessHost,
} from "./dsh-runtime-transport"

function config(
  process_?: Partial<NonNullable<ExternalAgentConfig["process"]>>
): ExternalAgentConfig {
  return {
    id: "agent-1",
    name: "DSH",
    protocol: "dsh-sdk",
    ...(process_ ? { process: process_ as NonNullable<ExternalAgentConfig["process"]> } : {}),
  } as unknown as ExternalAgentConfig
}

const INSTALLED = {
  command: "/bundled/node",
  args: ["/rt/launcher.mjs", "/rt/host.sdk-readonly.yml"],
  cwd: "/work",
  env: {
    DEEPSEEK_API_KEY: "sk-test-1234567890",
    COGNIA_DSH_WORKSPACE: "/work",
  },
}

describe("resolveDshLaunchFromConfig", () => {
  it("forwards process-wide reasoning and output limits", () => {
    expect(
      resolveDshLaunchFromConfig(
        config({
          ...INSTALLED,
          env: {
            ...INSTALLED.env,
            COGNIA_DSH_REASONING_EFFORT: "high",
            COGNIA_DSH_MAX_TOKENS: "8192",
          },
        })
      )
    ).toMatchObject({ reasoningEffort: "high", maxTokens: 8192 })
    expect(() =>
      resolveDshLaunchFromConfig(
        config({ ...INSTALLED, env: { ...INSTALLED.env, COGNIA_DSH_MAX_TOKENS: "-1" } })
      )
    ).toThrow(/positive safe integer/)
  })
  it("derives the launch spec from an installed config", () => {
    const launch = resolveDshLaunchFromConfig(config(INSTALLED))
    expect(launch).toMatchObject({
      command: "/bundled/node",
      args: ["/rt/launcher.mjs", "/rt/host.sdk-readonly.yml"],
      workspace: "/work",
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
    })
  })

  it("honours a model override from the environment", () => {
    const launch = resolveDshLaunchFromConfig(
      config({ ...INSTALLED, env: { ...INSTALLED.env, COGNIA_DSH_MODEL: "deepseek-v4-pro" } })
    )
    expect(launch.model).toBe("deepseek-v4-pro")
  })

  it("falls back to the process cwd when no workspace variable is set", () => {
    const launch = resolveDshLaunchFromConfig(
      config({ ...INSTALLED, env: { DEEPSEEK_API_KEY: "sk-test-1234567890" } })
    )
    expect(launch.workspace).toBe("/work")
  })

  it("reports an uninstalled agent with an actionable message", () => {
    // Better than letting the spawn fail with ENOENT on an empty command.
    expect(() => resolveDshLaunchFromConfig(config())).toThrow(DshRuntimeUnavailableError)
    expect(() => resolveDshLaunchFromConfig(config())).toThrow(/installer/i)
  })

  it("treats a config with a command but no args as uninstalled", () => {
    expect(() =>
      resolveDshLaunchFromConfig(config({ command: "/bundled/node", args: [] }))
    ).toThrow(DshRuntimeUnavailableError)
  })

  it("refuses to launch when no credential was resolved", () => {
    // Without this the model route fails deep inside the runtime with an opaque
    // provider error, and the cause is no longer attributable.
    expect(() => resolveDshLaunchFromConfig(config({ ...INSTALLED, env: {} }))).toThrow(
      /No DeepSeek credential/
    )
  })
})

function fixture(
  envOverrides: Record<string, string> = {},
  agentId = "agent-1",
  useProcessPlane = false
) {
  const listeners = new Map<string, (payload: never) => void>()
  const frames: Array<Record<string, unknown>> = []
  let processId = ""
  let respond = true
  let initializeResult: unknown = {
    serverInfo: { name: "deepseek-harness-sdk-runtime", version: "0.0.1" },
  }
  const emit = (channel: string, data: Record<string, unknown>) =>
    listeners.get(`external-agent://${channel}`)?.({ agentId: processId, ...data } as never)
  const wire = (value: unknown) =>
    emit("stdout-raw", { data: Buffer.from(`${JSON.stringify(value)}\n`).toString("base64") })
  const invoke = jest.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === "spawn_external_agent") processId = (args.config as { id: string }).id
    if (name === "send_to_external_agent") {
      const frame = JSON.parse(args.message as string)
      frames.push(frame)
      if (respond)
        wire({
          jsonrpc: "2.0",
          id: frame.id,
          result:
            frame.method === "initialize"
              ? initializeResult
              : frame.method === "session/prompt"
                ? { messageId: "receipt-1" }
                : {},
        })
    }
  })
  const host = {
    invoke: useProcessPlane ? agentInvoke : invoke,
    listen: jest.fn(async (channel: string, callback: (payload: never) => void) => {
      listeners.set(channel, callback)
      return () => {
        listeners.delete(channel)
      }
    }),
  } as unknown as DshProcessHost
  const transport = createDshRuntimeTransport(
    { ...config({ ...INSTALLED, env: { ...INSTALLED.env, ...envOverrides } }), id: agentId },
    resolveDshLaunchFromConfig,
    true,
    host
  )
  const handlers = { onNotification: jest.fn(), onClosed: jest.fn() }
  return {
    transport,
    handlers,
    host,
    invoke,
    listeners,
    frames,
    wire,
    emit,
    setRespond: (value: boolean) => {
      respond = value
    },
    setInitializeResult: (value: unknown) => {
      initializeResult = value
    },
  }
}

describe("DSH runtime-environment placement through the process plane", () => {
  let processHost: Transport
  beforeEach(() => {
    processHost = {} as Transport
  })
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

  function processFixture(agentId = "agent-1") {
    const f = fixture({}, agentId, true)
    Object.assign(processHost, { call: f.invoke })
    setActiveRemoteTransport(processHost)
    return f
  }

  it.each(["agent-1", "agent-1:dsh:session-1"])(
    "carries the project's placement to the host for %s",
    async (processId) => {
      registerSpawnPlacement("agent-1", placement)
      const f = processFixture(processId)
      await f.transport.start(f.handlers)
      try {
        expect(f.invoke).toHaveBeenCalledWith("spawn_external_agent", {
          config: expect.objectContaining({ id: processId, sandbox: placement }),
        })
        expect(spawnedPlacementDigest(processId)).toBe(placement.spec.specDigest)
      } finally {
        await f.transport.close()
      }
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
      const f = processFixture()
      await f.transport.start(f.handlers)
      try {
        const spawn = f.invoke.mock.calls.find(([name]) => name === "spawn_external_agent")![1]
        expect((spawn.config as { sandbox?: SandboxPlacement }).sandbox).toEqual(current)
        expect(spawnedPlacementDigest("agent-1")).toBe(current?.spec.specDigest ?? null)
      } finally {
        await f.transport.close()
      }
    }
  })

  it("keeps unselected DSH runs on the existing process path", async () => {
    const f = processFixture()
    await f.transport.start(f.handlers)
    try {
      const spawn = f.invoke.mock.calls.find(([name]) => name === "spawn_external_agent")![1]
      expect(spawn.config).not.toHaveProperty("sandbox")
    } finally {
      await f.transport.close()
    }
  })
})

describe("DSH host process transport", () => {
  it("sends supported initialization tuning and ignores unrelated host exits", async () => {
    const f = fixture({ COGNIA_DSH_MAX_TOKENS: "4096", COGNIA_DSH_REASONING_EFFORT: "high" })
    await f.transport.start(f.handlers)
    expect(f.frames[0].params).toMatchObject({ maxTokens: 4096, reasoningEffort: "high" })
    f.emit("exit", { agentId: "different-agent", code: 1 })
    expect(f.transport.isRunning()).toBe(true)
    await f.transport.close()
  })

  it("retains a redacted cleanup error when a failed handshake cannot be reaped", async () => {
    const f = fixture()
    f.setInitializeResult({})
    const original = f.invoke.getMockImplementation()!
    f.invoke.mockImplementation(async (name, args) => {
      if (name === "kill_external_agent") throw new Error("kill failed sk-test-1234567890")
      return original(name, args)
    })
    await expect(f.transport.start(f.handlers)).rejects.toThrow(
      "Cleanup failed: Error: kill failed [redacted]"
    )
    f.invoke.mockImplementation(original)
    await f.transport.close()
    expect(f.listeners.size).toBe(0)
  })

  it("can retry a failed process termination without losing ownership", async () => {
    const f = fixture()
    await f.transport.start(f.handlers)
    const original = f.invoke.getMockImplementation()!
    let attempts = 0
    f.invoke.mockImplementation(async (name, args) => {
      if (name === "kill_external_agent" && attempts++ === 0)
        throw new Error("host temporarily unavailable")
      return original(name, args)
    })
    await expect(f.transport.close()).rejects.toThrow("host temporarily unavailable")
    await f.transport.close()
    expect(attempts).toBe(2)
    expect(f.listeners.size).toBe(0)
  })

  it("does not kill a process that already exited after acknowledging shutdown", async () => {
    const f = fixture()
    await f.transport.start(f.handlers)
    const original = f.invoke.getMockImplementation()!
    f.invoke.mockImplementation(async (name, args) => {
      const result = await original(name, args)
      if (
        name === "send_to_external_agent" &&
        JSON.parse(args.message as string).method === "shutdown"
      ) {
        f.emit("exit", { code: 0 })
      }
      return result
    })
    await f.transport.close()
    expect(f.invoke.mock.calls.some(([name]) => name === "kill_external_agent")).toBe(false)
    expect(f.listeners.size).toBe(0)
  })

  it("cannot restart a transport closed before starting", async () => {
    const f = fixture()
    await f.transport.close()
    await expect(f.transport.start(f.handlers)).rejects.toThrow(/closed/)
    expect(f.invoke).not.toHaveBeenCalled()
  })
  it("closes a process even when disconnect races listener registration", async () => {
    const f = fixture()
    const started = f.transport.start(f.handlers)
    const closed = f.transport.close()
    await Promise.all([started, closed])
    expect(f.transport.isRunning()).toBe(false)
    expect(f.listeners.size).toBe(0)
    const methods = f.invoke.mock.calls.map(([name]) => name)
    expect(methods.indexOf("kill_external_agent")).toBeGreaterThan(
      methods.indexOf("spawn_external_agent")
    )
    await expect(f.transport.start(f.handlers)).rejects.toThrow(/already started/)
  })

  it("cleans registered listeners when host subscription fails", async () => {
    const f = fixture()
    jest.mocked(f.host.listen).mockRejectedValueOnce(new Error("subscription unavailable"))
    await expect(f.transport.start(f.handlers)).rejects.toThrow("subscription unavailable")
    expect(f.listeners.size).toBe(0)
    expect(f.transport.isRunning()).toBe(false)
  })

  it("bounds malformed raw frames and reaps the affected runtime", async () => {
    const f = fixture()
    await f.transport.start(f.handlers)
    f.emit("stdout-raw", { data: "%%%" })
    await f.transport.close()
    expect(f.handlers.onClosed).toHaveBeenCalledTimes(1)
    expect(f.transport.isRunning()).toBe(false)
    expect(f.listeners.size).toBe(0)
  })
  it("registers listeners before spawning and uses the host bridge for all three SDK methods", async () => {
    const f = fixture()
    await f.transport.start(f.handlers)
    expect(f.host.listen).toHaveBeenCalledTimes(3)
    expect(f.invoke).toHaveBeenCalledWith("spawn_external_agent", {
      config: expect.objectContaining({
        command: "/bundled/node",
        args: INSTALLED.args,
        cwd: "/work",
        framing: "raw",
      }),
    })
    expect(f.frames[0]).toMatchObject({
      jsonrpc: "2.0",
      method: "initialize",
      params: { cwd: "/work", provider: "deepseek-official", model: "deepseek-v4-flash" },
    })
    await expect(f.transport.prompt("s1", [{ type: "text", text: "hello" }])).resolves.toBe(
      "receipt-1"
    )
    expect(f.frames[1]).toMatchObject({
      method: "session/prompt",
      params: { sessionId: "s1", contentBlocks: [{ type: "text", text: "hello" }] },
    })
    await f.transport.close()
    expect(f.frames[2].method).toBe("shutdown")
    expect(f.invoke).toHaveBeenCalledWith("kill_external_agent", { agentId: expect.any(String) })
    expect(f.listeners.size).toBe(0)
    expect(f.transport.isRunning()).toBe(false)
    expect(f.handlers.onClosed).not.toHaveBeenCalled()
  })

  it("preserves split UTF-8 frames and filters another process's notifications", async () => {
    const f = fixture()
    await f.transport.start(f.handlers)
    const frame = Buffer.from(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session.event",
        params: { sessionId: "s1", text: "你好\u2028world" },
      }) + "\n"
    )
    const split = frame.indexOf(Buffer.from("你")) + 1
    f.emit("stdout-raw", { data: frame.subarray(0, split).toString("base64") })
    expect(f.handlers.onNotification).not.toHaveBeenCalled()
    f.emit("stdout-raw", { data: frame.subarray(split).toString("base64") })
    expect(f.handlers.onNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "session.event",
        params: { sessionId: "s1", text: "你好\u2028world" },
      })
    )
    f.emit("stdout-raw", { agentId: "someone-else", data: frame.toString("base64") })
    expect(f.handlers.onNotification).toHaveBeenCalledTimes(1)
    await f.transport.close()
  })

  it("reaps a child whose handshake fails or claims another server identity", async () => {
    const f = fixture()
    f.setInitializeResult({ serverInfo: { name: "other", version: "0.0.1" } })
    await expect(f.transport.start(f.handlers)).rejects.toThrow(/identity/)
    expect(f.invoke).toHaveBeenCalledWith("kill_external_agent", expect.anything())
    expect(f.listeners.size).toBe(0)
    expect(f.transport.isRunning()).toBe(false)
  })

  it("rejects unresolved prompts immediately on process exit and redacts stderr", async () => {
    const f = fixture()
    await f.transport.start(f.handlers)
    f.setRespond(false)
    const result = expect(
      f.transport.prompt("s1", [{ type: "text", text: "hello" }])
    ).rejects.toThrow(/exited/)
    f.emit("stderr", { data: "failed sk-test-1234567890" })
    f.emit("exit", { code: 1 })
    await result
    expect(f.handlers.onClosed).toHaveBeenCalledWith(expect.stringContaining("[redacted]"))
    expect(JSON.stringify(f.handlers.onClosed.mock.calls)).not.toContain("sk-test-1234567890")
    expect(f.listeners.size).toBe(0)
  })

  it("redacts credentials nested in session MCP configuration", async () => {
    const f = fixture({
      COGNIA_DSH_MCP_SERVERS: JSON.stringify([
        { env: [{ name: "COGNIA_TOOLHOST_TOKEN", value: "broker-secret-fixture" }] },
        { headers: [{ name: "Authorization", value: "Bearer remote-secret-fixture" }] },
      ]),
    })
    await f.transport.start(f.handlers)
    f.emit("stderr", { data: "broker-secret-fixture Bearer remote-secret-fixture" })
    f.emit("exit", { code: 1 })
    expect(JSON.stringify(f.handlers.onClosed.mock.calls)).not.toContain("secret-fixture")
    expect(JSON.stringify(f.handlers.onClosed.mock.calls)).toContain("[redacted]")
  })

  it("gates every outbound prompt before it reaches the process", async () => {
    const f = fixture()
    await f.transport.start(f.handlers)
    await expect(
      f.transport.prompt("s1", [{ type: "text", text: "alice@example.com" }])
    ).rejects.toThrow(/PII gate/)
    expect(f.frames).toHaveLength(1)
    await f.transport.close()
  })

  it("does not send unsupported cancel notifications when a prompt times out", async () => {
    jest.useFakeTimers()
    try {
      const f = fixture()
      await f.transport.start(f.handlers)
      f.setRespond(false)
      const pending = expect(
        f.transport.prompt("s1", [{ type: "text", text: "hello" }])
      ).rejects.toThrow(/timeout/)
      jest.advanceTimersByTime(30000)
      await pending
      expect(f.frames.map((frame) => frame.method)).toEqual(["initialize", "session/prompt"])
      f.setRespond(true)
      await f.transport.close()
    } finally {
      jest.useRealTimers()
    }
  })

  it("rejects malformed enqueue receipts", async () => {
    const f = fixture()
    await f.transport.start(f.handlers)
    f.setRespond(false)
    const pending = expect(
      f.transport.prompt("s1", [{ type: "text", text: "hello" }])
    ).rejects.toThrow(/receipt/)
    f.wire({ jsonrpc: "2.0", id: 2, result: {} })
    await pending
    f.setRespond(true)
    await f.transport.close()
  })

  it("requires an available process host and an active connection", async () => {
    expect(() =>
      createDshRuntimeTransport(config(INSTALLED), resolveDshLaunchFromConfig, false)
    ).toThrow(/host/)
    const f = fixture()
    await expect(f.transport.prompt("s", [])).rejects.toThrow(/not running/)
    await f.transport.close()
    expect(f.invoke).not.toHaveBeenCalled()
  })
})
