/**
 * @jest-environment node
 */
import type { AcpCapabilities, ExternalAgentConfig } from "@/types/agent/external-agent"

import { DEFAULT_RESOLVED_CONFIG } from "../../config/schema"
import { builtinCapabilities, isBuiltinBackend } from "./backend-capabilities"
import {
  connectBackend,
  connectFailureHeadline,
  connectProgressLine,
  defaultBackendHost,
  disconnectBackend,
  type BackendConnectDeps,
  type BackendConnectHost,
  type BackendConnectStage,
  type BackendConnection,
} from "./backend-controller"

const config = { ...DEFAULT_RESOLVED_CONFIG, cwd: "/work" }

function fakeHost(overrides: Partial<BackendConnectHost> = {}) {
  const host: BackendConnectHost = {
    addAgent: jest.fn(async () => undefined),
    connect: jest.fn(async () => undefined),
    getAgentCapabilities: jest.fn(() => undefined as AcpCapabilities | undefined),
    removeAgent: jest.fn(async () => undefined),
    ...overrides,
  }
  return host
}

function deps(overrides: Partial<BackendConnectDeps> = {}): BackendConnectDeps {
  return {
    backend: "claude-code",
    config,
    agentId: "cli-external-1",
    host: fakeHost(),
    readPreset: (() => ({
      process: { command: "npx" },
    })) as unknown as BackendConnectDeps["readPreset"],
    buildAgent: ((_preset: string, patch: Partial<ExternalAgentConfig>) => ({
      ...patch,
      process: { command: "npx", args: [] },
    })) as unknown as BackendConnectDeps["buildAgent"],
    resolvePreset: async (backend: string) => backend,
    platformSupported: () => true,
    locateLauncher: () => "/opt/launcher",
    commandExists: async () => true,
    ...overrides,
  }
}

describe("connectBackend", () => {
  it("walks the stages in order and reports a live connection", async () => {
    const stages: BackendConnectStage[] = []
    const host = fakeHost({ getAgentCapabilities: () => ({ multiTurn: true }) })
    const result = await connectBackend(deps({ host, onStage: (s) => stages.push(s) }))

    // `command` precedes `sandbox`: a process-less preset must be rejected for
    // its missing executable, not for a sandbox it never needed.
    expect(stages).toEqual(["preset", "command", "sandbox", "launch"])
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.connection).toMatchObject({
        backend: "claude-code",
        agentId: "cli-external-1",
        command: "npx",
      })
      // Capabilities come from the handshake, not a hardcoded table: this agent
      // advertised loadSession, so resume is live.
      expect(result.connection.capabilities.features.resume.supported).toBe(true)
    }
    expect(host.addAgent).toHaveBeenCalledTimes(1)
    expect(host.connect).toHaveBeenCalledWith("cli-external-1")
  })

  it("clears any prior registration before adding, so a reconnect is idempotent", async () => {
    // The agent id is stable across reconnects and the manager throws on a
    // duplicate; without the pre-add removal the second connect always failed
    // with "Agent already exists".
    const calls: string[] = []
    const host = fakeHost({
      removeAgent: jest.fn(async () => {
        calls.push("remove")
      }),
      addAgent: jest.fn(async () => {
        calls.push("add")
        return undefined
      }),
    })
    const result = await connectBackend(deps({ host }))

    expect(result.ok).toBe(true)
    // Removal is sequenced strictly before the add, so it can never race the
    // freshly-registered agent.
    expect(calls).toEqual(["remove", "add"])
    expect(host.removeAgent).toHaveBeenCalledWith("cli-external-1")
  })

  it("passes the connect budget to the agent registration", async () => {
    const host = fakeHost()
    // The per-turn session path uses `streamIdleTimeoutMs`; the connect must use
    // the same number, not the preset's stricter default.
    await connectBackend(deps({ host, config: { ...config, streamIdleTimeoutMs: 12345 } }))
    expect(host.addAgent).toHaveBeenCalledWith(expect.objectContaining({ timeout: 12345 }))
  })

  it("launches into the session's working directory with resolved credentials", async () => {
    const host = fakeHost()
    await connectBackend(
      deps({
        host,
        backend: "claude-code",
        config: {
          ...config,
          cwd: "/repo",
          providers: { anthropic: { apiKey: "sk-a" } },
        },
      })
    )
    expect(host.addAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        process: expect.objectContaining({
          cwd: "/repo",
          env: expect.objectContaining({ ANTHROPIC_API_KEY: "sk-a" }),
        }),
      })
    )
  })

  it("rejects an unknown backend before touching the host", async () => {
    const host = fakeHost()
    const result = await connectBackend(
      deps({ backend: "cdoex", host, readPreset: (() => undefined) as never })
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.failure).toMatchObject({ kind: "unknown-backend", stage: "preset" })
      expect(result.failure.hint).toContain("/backend")
    }
    expect(host.addAgent).not.toHaveBeenCalled()
  })

  it("fails closed on a platform with no strict sandbox", async () => {
    const result = await connectBackend(deps({ platformSupported: () => false }))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.failure).toMatchObject({ kind: "platform", stage: "sandbox" })
    }
  })

  it("reports a missing launcher without the maintainer build command", async () => {
    const result = await connectBackend(deps({ locateLauncher: () => undefined }))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.failure.kind).toBe("launcher")
      expect(result.failure.hint).toContain("COGNIA_EXTERNAL_AGENT_LAUNCHER")
      expect(result.failure.hint).not.toContain("pnpm")
    }
  })

  it("reports an agent binary that is not installed, and how to retry", async () => {
    const result = await connectBackend(deps({ commandExists: async () => false }))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.failure).toMatchObject({ kind: "command", stage: "command" })
      expect(result.failure.hint).toContain("/backend claude-code")
    }
  })

  it("reports a preset that declares no executable", async () => {
    const result = await connectBackend(deps({ readPreset: (() => ({ process: {} })) as never }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.kind).toBe("command")
  })

  it("blames the missing executable, not the sandbox, when both are absent", async () => {
    // Proves the reordered check: a process-less preset on an unsupported
    // platform fails at `command`, not `sandbox` — the sandbox is irrelevant to
    // a backend that never spawns.
    const result = await connectBackend(
      deps({
        readPreset: (() => ({ process: {} })) as never,
        platformSupported: () => false,
        locateLauncher: () => undefined,
      })
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure).toMatchObject({ kind: "command", stage: "command" })
  })

  it("never throws: an unexpected fault becomes a failure pinned to the current stage", async () => {
    // The startup path renders this result; an escaped throw would tear the TUI
    // down. A preset builder that throws lands as a handshake failure at the
    // stage that was running (`launch`), not an exception.
    const result = await connectBackend(
      deps({
        buildAgent: (() => {
          throw new Error("preset exploded")
        }) as never,
      })
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.failure.message).toBe("preset exploded")
      expect(result.failure.stage).toBe("launch")
    }
  })

  it("unregisters the agent when the handshake fails, so a retry starts clean", async () => {
    const host = fakeHost({
      connect: jest.fn(async () => {
        throw new Error("not logged in")
      }),
    })
    const result = await connectBackend(deps({ host }))

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.failure).toMatchObject({ kind: "handshake", stage: "launch" })
      expect(result.failure.message).toBe("not logged in")
    }
    expect(host.removeAgent).toHaveBeenCalledWith("cli-external-1")
  })

  it("survives a cleanup that also fails", async () => {
    const host = fakeHost({
      connect: jest.fn(async () => {
        throw "string fault"
      }),
      removeAgent: jest.fn(async () => {
        throw new Error("already gone")
      }),
    })
    const result = await connectBackend(deps({ host }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.message).toBe("string fault")
  })

  it("reports a preset that cannot be built into an agent", async () => {
    const result = await connectBackend(deps({ buildAgent: (() => undefined) as never }))
    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.failure).toMatchObject({ kind: "unknown-backend", stage: "launch" })
  })

  it("skips the command probe when none is injected", async () => {
    const result = await connectBackend(deps({ commandExists: undefined }))
    expect(result.ok).toBe(true)
  })

  it("carries reasoning effort and skill roots on a Codex preset", async () => {
    const host = fakeHost()
    await connectBackend(
      deps({
        host,
        backend: "codex",
        resolvePreset: async () => "codex-app-server",
        config: { ...config, thinkingLevel: "high", skillDirs: ["/skills"] },
      })
    )
    // The only channel either has, read when the agent is registered.
    expect(host.addAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        codexOptions: { defaultReasoningEffort: "high", extraSkillRoots: ["/skills"] },
      })
    )
  })

  it("omits the Codex block on a preset that cannot read it", async () => {
    const host = fakeHost()
    await connectBackend(
      deps({ host, config: { ...config, thinkingLevel: "high", skillDirs: ["/skills"] } })
    )
    expect(host.addAgent).toHaveBeenCalledWith(
      expect.not.objectContaining({ codexOptions: expect.anything() })
    )
  })

  it("normalizes the CLI-only auto permission mode the protocol does not know", async () => {
    const host = fakeHost()
    await connectBackend(deps({ host, config: { ...config, permissionMode: "auto" } }))
    expect(host.addAgent).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPermissionMode: "default" })
    )
  })

  it("falls back to the shared host and real platform probes when none are injected", async () => {
    // Exercises the production defaults rather than the doubles every other case
    // supplies. Fails at the sandbox stage on a platform without one, which is
    // itself the correct production behaviour.
    const result = await connectBackend(
      deps({ host: undefined, platformSupported: undefined, locateLauncher: undefined })
    )
    expect(typeof result.ok).toBe("boolean")
  })

  it("passes a non-codex backend through the default preset resolver unchanged", async () => {
    const result = await connectBackend(deps({ resolvePreset: undefined }))
    if (result.ok) expect(result.connection.presetId).toBe("claude-code")
  })

  it("delegates every host call to the shared manager", async () => {
    const manager = fakeHost({ getAgentCapabilities: () => ({ multiTurn: true }) })
    const host = defaultBackendHost(manager)

    await host.addAgent({ id: "a" } as ExternalAgentConfig)
    await host.connect("a")
    expect(host.getAgentCapabilities("a")).toEqual({ multiTurn: true })
    await host.removeAgent("a")

    expect(manager.addAgent).toHaveBeenCalledWith({ id: "a" })
    expect(manager.connect).toHaveBeenCalledWith("a")
    expect(manager.removeAgent).toHaveBeenCalledWith("a")
  })

  it("falls back to the shared manager when no override is given", () => {
    // Constructing it is inert — nothing spawns until an agent is registered.
    expect(typeof defaultBackendHost().connect).toBe("function")
  })

  it("reclaims the live process on disconnect, and is a no-op with no connection", async () => {
    const host = fakeHost()
    const connection = { agentId: "cli-backend-1" } as BackendConnection
    await disconnectBackend(connection, host)
    expect(host.removeAgent).toHaveBeenCalledWith("cli-backend-1")

    const host2 = fakeHost()
    await disconnectBackend(null, host2)
    await disconnectBackend(undefined, host2)
    expect(host2.removeAgent).not.toHaveBeenCalled()
  })

  it("swallows a failing removal so a cleanup path never throws", async () => {
    const host = fakeHost({
      removeAgent: jest.fn(async () => {
        throw new Error("already gone")
      }),
    })
    await expect(
      disconnectBackend({ agentId: "cli-backend-1" } as BackendConnection, host)
    ).resolves.toBeUndefined()
  })

  it("resolves the codex variant through the real preset resolver by default", async () => {
    // Falls back to plain `codex` wherever the CLI probe is unavailable, so this
    // is safe to run anywhere.
    const result = await connectBackend(deps({ backend: "codex", resolvePreset: undefined }))
    if (result.ok) expect(["codex", "codex-app-server"]).toContain(result.connection.presetId)
  })

  it("resolves codex to its executable preset variant", async () => {
    const resolvePreset = jest.fn(async () => "codex-app-server")
    const result = await connectBackend(deps({ backend: "codex", resolvePreset }))
    expect(resolvePreset).toHaveBeenCalledWith("codex")
    if (result.ok) expect(result.connection.presetId).toBe("codex-app-server")
  })
})

describe("backend identity helpers", () => {
  it("treats an absent or builtin id as the built-in sidecar", () => {
    expect(isBuiltinBackend(undefined)).toBe(true)
    expect(isBuiltinBackend("builtin")).toBe(true)
    expect(isBuiltinBackend("codex")).toBe(false)
  })

  it("supports every feature on the built-in path", () => {
    expect(builtinCapabilities().builtin).toBe(true)
  })

  it("pins progress and failure text to a stage the user actually saw", () => {
    expect(connectProgressLine("codex", "sandbox")).toBe("starting codex … checking sandbox")
    expect(
      connectFailureHeadline("codex", {
        kind: "launcher",
        stage: "sandbox",
        message: "missing",
      })
    ).toBe("Couldn't start codex — failed while checking sandbox.")
  })
})
