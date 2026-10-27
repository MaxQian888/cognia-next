import type {
  AgentProcessHost,
  AgentProcessOutputEvent,
  AgentProcessExitEvent,
} from "@cognia/agent-contracts/host"
import type { ExternalAgentConfig } from "@cognia/agent-contracts/external-agent"
import { createHermesControlledDaemonHost, hermesStateKey } from "./hermes-daemon"

describe("owned foreground Hermes daemon leases", () => {
  function fixture() {
    const lines = new Set<(event: AgentProcessOutputEvent) => void>()
    const exits = new Set<(event: AgentProcessExitEvent) => void>()
    let failProbe = false
    const host: AgentProcessHost = {
      available: true,
      spawn: jest.fn(async (spec) => spec.id),
      send: jest.fn(async (id, data) => {
        const request = JSON.parse(data)
        for (const listener of lines)
          listener({
            processId: id,
            data: JSON.stringify(
              failProbe
                ? { ready: false, code: "runtime_owner_mismatch" }
                : {
                    ready: true,
                    endpoint: {
                      profileId: request.expectedHome,
                      instanceId: "a".repeat(32),
                      authorityEpoch: 1,
                      apiOrigin: "http://127.0.0.1:12345",
                      runtimeProtocol: 1,
                    },
                  }
            ),
          })
      }),
      kill: jest.fn(async () => undefined),
      commandExists: jest.fn(async () => true),
      onStdoutLine: async (listener) => {
        lines.add(listener)
        return () => {
          lines.delete(listener)
        }
      },
      onStdoutRaw: async () => () => undefined,
      onStderr: async () => () => undefined,
      onExit: async (listener) => {
        exits.add(listener)
        return () => {
          exits.delete(listener)
        }
      },
    }
    const dependencies = {
      processHost: host,
      ownsLocalProcesses: (): boolean => true,
      stateRootInfo: async (key) => ({
        path: `/data/cognia/external-agents/${key}`,
        exists: true,
        bytes: 0,
      }),
      processInfo: async (id) => ({ id, pid: 123, state: "Starting" }),
      resolveBridge: async (id) => ({
        command: "/owned/node",
        args: [
          `/owned/native-agents/${id}.cjs`,
          id === "hermes-probe" ? "--hermes-gateway-probe" : "--cognia-hermes-acp",
        ],
        sha256: "b".repeat(64),
      }),
      resolveEnvironment: async (_config, env) => env,
      startupTimeoutMs: 100,
      retryDelayMs: 1,
    } satisfies import("./hermes-daemon").HermesControlledDaemonDeps
    const coordinator = createHermesControlledDaemonHost(dependencies)
    const key = hermesStateKey("configuration")
    const config = {
      id: "configuration",
      enabled: true,
      stateIsolation: "isolated",
      name: "Hermes",
      protocol: "acp",
      transport: "stdio",
      process: {
        command: "hermes",
        args: ["acp"],
        cwd: "/work",
        env: {
          COGNIA_AGENT_STATE_KEY: key,
          HERMES_HOME: "/personal",
          HERMES_TUI_GATEWAY_URL: "wss://foreign",
        },
      },
    } as ExternalAgentConfig
    return {
      dependencies,
      coordinator,
      host,
      config,
      lines,
      exits,
      key,
      failProbe: () => {
        failProbe = true
      },
    }
  }

  it("deduplicates startup, confines the actual foreground owner and refcounts viewers", async () => {
    const h = fixture()
    const [a, b] = await Promise.all([
      h.coordinator(h.config),
      h.coordinator({ ...h.config, id: "configuration:acp:1" }),
    ])
    const spawns = (h.host.spawn as jest.Mock).mock.calls.map(([spec]) => spec)
    expect(spawns.filter((spec) => spec.command === "hermes")).toHaveLength(1)
    const daemon = spawns.find((spec) => spec.command === "hermes")!
    expect(daemon.args).toEqual([
      "--profile",
      "default",
      "gateway",
      "run",
      "--quiet",
      "--no-supervise",
      "--external-supervisor",
    ])
    expect(daemon.env).toMatchObject({
      COGNIA_AGENT_STATE_KEY: h.key,
      HERMES_HOME: `/data/cognia/external-agents/${h.key}/hermes`,
      HERMES_TUI_GATEWAY_URL: "",
    })
    await a.release()
    expect(a.launch).toEqual({
      command: "/owned/node",
      args: ["/owned/native-agents/hermes-acp.cjs", "--cognia-hermes-acp"],
    })
    expect(JSON.parse(a.env.COGNIA_HERMES_ACP_BOOTSTRAP)).toMatchObject({
      expectedPid: 123,
      instanceId: "a".repeat(32),
      authorityEpoch: 1,
    })
    expect(h.host.kill).not.toHaveBeenCalledWith(daemon.id)
    await b.release()
    expect(h.host.kill).toHaveBeenCalledWith(daemon.id)
    expect(h.lines.size).toBe(0)
    expect(h.exits.size).toBe(0)
  })
  it("keeps stable native state across child ordering and relaunch", async () => {
    expect(hermesStateKey("configuration")).toBe("configuration")
    const h = fixture(),
      first = await h.coordinator(h.config)
    await first.release()
    const second = await h.coordinator({ ...h.config, id: "configuration:acp:99" })
    expect(second.env.HERMES_HOME).toBe(first.env.HERMES_HOME)
    await second.release()
  })
  it("refuses remote-only ownership and unsupported native launch overrides", async () => {
    const h = fixture()
    h.dependencies.ownsLocalProcesses = () => false
    await expect(h.coordinator(h.config)).rejects.toThrow("configured native Host")
    h.dependencies.ownsLocalProcesses = () => true
    await expect(
      h.coordinator({ ...h.config, process: { ...h.config.process!, cwd: undefined } })
    ).rejects.toThrow("workspace")
    await expect(
      h.coordinator({
        ...h.config,
        process: { ...h.config.process!, args: ["--profile", "personal", "acp"] },
      })
    ).rejects.toThrow("profile")
    expect(h.host.spawn).not.toHaveBeenCalled()
  })
  it("rejects a foreign live descriptor and reaps every process it launched", async () => {
    const h = fixture()
    h.failProbe()
    await expect(h.coordinator(h.config)).rejects.toThrow("runtime_owner_mismatch")
    const daemon = (h.host.spawn as jest.Mock).mock.calls
      .map(([spec]) => spec)
      .find((spec) => spec.command === "hermes")!
    expect(h.host.kill).toHaveBeenCalledWith(daemon.id)
    expect(h.lines.size).toBe(0)
    expect(h.exits.size).toBe(0)
  })
  it("does not reuse an owner under a different workspace or sandbox policy", async () => {
    const h = fixture(),
      lease = await h.coordinator(h.config)
    await expect(
      h.coordinator({ ...h.config, process: { ...h.config.process!, cwd: "/outside" } })
    ).rejects.toThrow("workspace")
    await expect(h.coordinator({ ...h.config, sandboxPolicy: { network: "off" } })).rejects.toThrow(
      "policy"
    )
    await lease.release()
  })
  it("retains failed cleanup for a retry and never adopts an unowned daemon", async () => {
    const h = fixture(),
      lease = await h.coordinator(h.config)
    const daemon = (h.host.spawn as jest.Mock).mock.calls
      .map(([spec]) => spec)
      .find((spec) => spec.command === "hermes")!
    ;(h.host.kill as jest.Mock).mockImplementationOnce(async (id) => {
      if (id === daemon.id) throw new Error("kill failed")
    })
    await expect(lease.release()).rejects.toThrow("kill failed")
    await lease.release()
    expect((h.host.kill as jest.Mock).mock.calls.filter(([id]) => id === daemon.id)).toHaveLength(2)
  })
  it("waits for an owned stop before allowing a new foreground incarnation", async () => {
    const h = fixture(),
      first = await h.coordinator(h.config)
    const daemon = (h.host.spawn as jest.Mock).mock.calls
      .map(([spec]) => spec)
      .find((spec) => spec.command === "hermes")!
    let finishStop!: () => void
    const gate = new Promise<void>((resolve) => {
      finishStop = resolve
    })
    ;(h.host.kill as jest.Mock).mockImplementation(async (id) => {
      if (id === daemon.id) await gate
    })
    const stopping = first.release()
    const acquiring = h.coordinator(h.config)
    await Promise.resolve()
    expect(
      (h.host.spawn as jest.Mock).mock.calls.filter(([spec]) => spec.command === "hermes")
    ).toHaveLength(1)
    finishStop()
    await stopping
    const second = await acquiring
    expect(
      (h.host.spawn as jest.Mock).mock.calls.filter(([spec]) => spec.command === "hermes")
    ).toHaveLength(2)
    await second.release()
  })
  it("does not reuse a gateway that exited while viewers still hold leases", async () => {
    const h = fixture(),
      lease = await h.coordinator(h.config)
    const daemon = (h.host.spawn as jest.Mock).mock.calls
      .map(([spec]) => spec)
      .find((spec) => spec.command === "hermes")!
    for (const listener of h.exits) listener({ processId: daemon.id, code: 1 })
    await expect(h.coordinator(h.config)).rejects.toThrow("foreground gateway exited")
    await lease.release()
  })
})
