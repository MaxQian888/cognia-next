import type { ResolvedAgentExecutionSpec } from "@cognia/agent-config-types/agent-execution"

import {
  AgentCapabilityError,
  createAgentExecutionHandle,
  FrozenModelBindingError,
  nextCommandId,
} from "./agent-execution-handle"

function spec(overrides: Partial<ResolvedAgentExecutionSpec> = {}): ResolvedAgentExecutionSpec {
  return {
    specVersion: 1,
    identity: { sessionId: "s1", runId: "r1", attemptId: "a1" },
    executionFingerprint: "aexf1-x",
    executionKind: "agent",
    runtimeAdapter: "claude-agent-sdk",
    runtimePolicySource: "auto",
    modelBindings: { primary: "claude-sonnet-5", fast: "claude-haiku-4-5-20251001" },
    route: { kind: "direct", routePolicy: "direct" },
    hostRef: "desktop-sidecar",
    compatibility: { evidence: "native" },
    capabilities: {
      effective: [
        "streaming",
        "compaction",
        "permissions.interrupt-resume",
        "permissions.set-mode",
        "set-model",
      ],
      disabledOptional: [],
    },
    fallbackPolicy: "none",
    ...overrides,
  }
}

function makeDeps() {
  return {
    ipc: {
      interruptSession: jest.fn().mockResolvedValue(undefined),
      compactSession: jest.fn().mockResolvedValue(undefined),
      setSessionMode: jest.fn().mockResolvedValue(undefined),
      setSessionModel: jest.fn().mockResolvedValue(undefined),
      subscribeAgentEvents: jest.fn().mockImplementation(async (cb: (e: unknown) => void) => {
        makeDeps.lastSubscriber = cb
        return jest.fn()
      }),
      resolvePermission: jest.fn().mockResolvedValue(undefined),
      sessionControl: jest.fn().mockResolvedValue("control-result"),
    },
    closeSession: jest.fn().mockResolvedValue(undefined),
    recordCapabilityOutcome: jest.fn().mockResolvedValue(undefined),
  }
}
makeDeps.lastSubscriber = undefined as unknown as (e: unknown) => void

describe("createAgentExecutionHandle", () => {
  it("routes supported commands through the injected IPC", async () => {
    const deps = makeDeps()
    const handle = createAgentExecutionHandle("s1", spec(), deps)

    await handle.interrupt()
    await handle.compact("focus")
    await handle.resolvePermission("req-1", "allow", { message: "ok" })
    await handle.setPermissionMode("plan")
    await handle.cancel()

    expect(deps.ipc.interruptSession).toHaveBeenCalledWith("s1")
    expect(deps.ipc.compactSession).toHaveBeenCalledWith("s1", "focus")
    expect(deps.ipc.resolvePermission).toHaveBeenCalledWith(
      "s1",
      "req-1",
      "allow",
      "ok",
      undefined,
      undefined
    )
    expect(deps.ipc.setSessionMode).toHaveBeenCalledWith("s1", "plan")
    expect(deps.closeSession).toHaveBeenCalledWith("s1")
    expect(deps.recordCapabilityOutcome).toHaveBeenCalledWith("compaction", "success", undefined)
    expect(deps.recordCapabilityOutcome).toHaveBeenCalledWith(
      "permissions.interrupt-resume",
      "success",
      undefined
    )
    expect(deps.recordCapabilityOutcome).toHaveBeenCalledWith(
      "permissions.set-mode",
      "success",
      undefined
    )
  })

  it("records only explicit capability/protocol failures in the health circuit", async () => {
    const deps = makeDeps()
    const handle = createAgentExecutionHandle("s1", spec(), deps)

    deps.ipc.compactSession.mockRejectedValueOnce(new Error("RPC method not found: compact"))
    await expect(handle.compact()).rejects.toThrow("method not found")
    expect(deps.recordCapabilityOutcome).toHaveBeenCalledWith(
      "compaction",
      "failure",
      expect.any(Error)
    )

    deps.recordCapabilityOutcome.mockClear()
    deps.ipc.compactSession.mockRejectedValueOnce(new Error("authentication failed"))
    await expect(handle.compact()).rejects.toThrow("authentication failed")
    expect(deps.recordCapabilityOutcome).not.toHaveBeenCalled()
  })

  it("throws typed capability errors BEFORE any IPC for unsupported commands", async () => {
    const deps = makeDeps()
    const limited = spec({
      capabilities: { effective: ["streaming"], disabledOptional: [] },
    })
    const handle = createAgentExecutionHandle("s1", limited, deps)

    await expect(handle.compact()).rejects.toThrow(AgentCapabilityError)
    await expect(handle.setModel("claude-sonnet-5")).rejects.toThrow(AgentCapabilityError)
    await expect(handle.setPermissionMode("plan")).rejects.toThrow(AgentCapabilityError)
    await expect(handle.resolvePermission("r", "deny")).rejects.toThrow(AgentCapabilityError)
    expect(deps.ipc.compactSession).not.toHaveBeenCalled()
    expect(deps.ipc.setSessionModel).not.toHaveBeenCalled()
    expect(deps.ipc.setSessionMode).not.toHaveBeenCalled()
    expect(deps.ipc.resolvePermission).not.toHaveBeenCalled()
  })

  it("setModel only accepts models frozen into the spec bindings", async () => {
    const deps = makeDeps()
    const handle = createAgentExecutionHandle("s1", spec(), deps)

    await handle.setModel("claude-haiku-4-5-20251001")
    expect(deps.ipc.setSessionModel).toHaveBeenCalledWith("s1", "claude-haiku-4-5-20251001")

    await expect(handle.setModel("gpt-4o")).rejects.toThrow(FrozenModelBindingError)
    expect(deps.ipc.setSessionModel).toHaveBeenCalledTimes(1)
  })

  it("filters envelope events to this session", async () => {
    const deps = makeDeps()
    const handle = createAgentExecutionHandle("s1", spec(), deps)
    const seen: unknown[] = []
    await handle.events((e) => seen.push(e))

    const subscriber = makeDeps.lastSubscriber
    subscriber({ sessionId: "s1", sequence: 0 })
    subscriber({ sessionId: "other", sequence: 0 })
    expect(seen).toHaveLength(1)
  })

  it("mints unique idempotency command ids", () => {
    const ids = new Set(Array.from({ length: 50 }, () => nextCommandId()))
    expect(ids.size).toBe(50)
    for (const id of ids) expect(id).toMatch(/^cmd-\d+-/)
  })
})

describe("default (uninjected) transport wiring", () => {
  const call = jest.fn().mockResolvedValue(undefined)

  beforeEach(() => {
    call.mockClear()
    jest.doMock("@/lib/tauri", () => ({ transport: { call } }))
  })

  afterEach(() => {
    jest.dontMock("@/lib/tauri")
  })

  /** Every default-path command, with the payload keys that must survive. */
  const cases: Array<{
    name: string
    command: string
    run: (h: ReturnType<typeof createAgentExecutionHandle>) => Promise<void>
    extra?: Record<string, unknown>
  }> = [
    { name: "interrupt", command: "agent_interrupt", run: (h) => h.interrupt() },
    {
      name: "compact",
      command: "agent_compact",
      run: (h) => h.compact("focus here"),
      extra: { focus: "focus here" },
    },
    {
      name: "resolvePermission",
      command: "agent_resolve_permission",
      run: (h) => h.resolvePermission("req-1", "allow"),
      extra: { requestId: "req-1", decision: "allow" },
    },
    { name: "cancel", command: "agent_close_session", run: (h) => h.cancel() },
  ]

  it.each(cases)(
    "$name reaches the canonical $command with an idempotency key",
    async ({ command, run, extra }) => {
      // The handle's contract says every command carries a `commandId` the host
      // dedupes on. It was stamped here all along — but the Rust commands did
      // not declare the parameter, so it was dropped before the sidecar payload
      // was built and deduplication never fired from the desktop renderer.
      const handle = createAgentExecutionHandle("s1", spec())
      await run(handle)

      expect(call).toHaveBeenCalledTimes(1)
      const [name, payload] = call.mock.calls[0] as [string, Record<string, unknown>]
      expect(name).toBe(command)
      expect(payload.sessionId).toBe("s1")
      expect(payload.commandId).toEqual(expect.stringMatching(/^cmd-\d+-/))
      for (const [k, v] of Object.entries(extra ?? {})) expect(payload[k]).toEqual(v)
    }
  )

  it("never reaches the deprecated claude_* aliases", async () => {
    // Using them would both pollute the Phase-9 retirement telemetry and lose
    // the idempotency key, since only the `agent_*` commands accept one.
    const handle = createAgentExecutionHandle("s1", spec())
    await handle.interrupt()
    await handle.compact()
    await handle.cancel()

    for (const [name] of call.mock.calls as Array<[string]>) {
      expect(name.startsWith("claude_")).toBe(false)
    }
  })
})

describe("deny interrupt", () => {
  it("forwards an interrupting deny, and defaults to a plain refusal", async () => {
    // "Not this tool" and "stop what you are doing" are different answers, so
    // the interrupting form has to be asked for explicitly.
    const deps = makeDeps()
    const handle = createAgentExecutionHandle("s1", spec(), deps)

    await handle.resolvePermission("req-1", "deny", { message: "no", interrupt: true })
    expect(deps.ipc.resolvePermission).toHaveBeenLastCalledWith(
      "s1",
      "req-1",
      "deny",
      "no",
      undefined,
      true
    )

    await handle.resolvePermission("req-2", "deny")
    expect(deps.ipc.resolvePermission).toHaveBeenLastCalledWith(
      "s1",
      "req-2",
      "deny",
      undefined,
      undefined,
      undefined
    )
  })
})

describe("session controls", () => {
  const FULL = [
    "streaming",
    "compaction",
    "permissions.interrupt-resume",
    "permissions.set-mode",
    "set-model",
    "plugins.native",
    "skills.native",
    "checkpoint",
    "mcp.dynamic",
    "subagents.manage",
    "tasks.background",
    "session.manage",
    "context-management",
  ] as const

  const withControls = () => spec({ capabilities: { effective: [...FULL], disabledOptional: [] } })

  it("checks the capability BEFORE any IPC, not after the response comes back", async () => {
    // The spec in `spec()` has none of the Stage 3 capabilities.
    const deps = makeDeps()
    const handle = createAgentExecutionHandle("s1", spec(), deps)

    await expect(handle.reloadPlugins()).rejects.toBeInstanceOf(AgentCapabilityError)
    await expect(handle.stopTask("t1")).rejects.toBeInstanceOf(AgentCapabilityError)
    await expect(handle.readFile("/a")).rejects.toBeInstanceOf(AgentCapabilityError)
    expect(deps.ipc.sessionControl).not.toHaveBeenCalled()
  })

  it("names the capability that was missing", async () => {
    const handle = createAgentExecutionHandle("s1", spec(), makeDeps())
    await expect(handle.reloadSkills()).rejects.toMatchObject({ capability: "skills.native" })
    await expect(handle.supportedAgents()).rejects.toMatchObject({
      capability: "subagents.manage",
    })
  })

  it("forwards each control under its SDK parameter names", async () => {
    const deps = makeDeps()
    const handle = createAgentExecutionHandle("s1", withControls(), deps)

    await handle.reloadPlugins()
    await handle.readFile("/a/b", { encoding: "base64" })
    await handle.seedReadState("/a/b", 1234)
    await handle.setMcpServers({ github: { type: "http", url: "https://x" } })
    await handle.setMcpPermissionModeOverride("github", "default")
    await handle.stopTask("task-9")
    await handle.applyFlagSettings({ effortLevel: "max" })

    expect(deps.ipc.sessionControl.mock.calls).toEqual([
      ["s1", "reloadPlugins", undefined],
      ["s1", "readFile", { path: "/a/b", options: { encoding: "base64" } }],
      ["s1", "seedReadState", { path: "/a/b", mtime: 1234 }],
      ["s1", "setMcpServers", { servers: { github: { type: "http", url: "https://x" } } }],
      ["s1", "setMcpPermissionModeOverride", { serverName: "github", mode: "default" }],
      ["s1", "stopTask", { taskId: "task-9" }],
      ["s1", "applyFlagSettings", { settings: { effortLevel: "max" } }],
    ])
  })

  it("rewinds as a DRY RUN unless the caller explicitly asks to write", async () => {
    // The SDK's own default is `dryRun: false`, i.e. it overwrites the working
    // tree. Inheriting that default in a UI facade makes the easiest call the
    // destructive one.
    const deps = makeDeps()
    const handle = createAgentExecutionHandle("s1", withControls(), deps)

    await handle.rewindFiles("u-1")
    expect(deps.ipc.sessionControl).toHaveBeenLastCalledWith("s1", "rewindFiles", {
      userMessageId: "u-1",
      options: { dryRun: true },
    })

    await handle.rewindFiles("u-1", { dryRun: false })
    expect(deps.ipc.sessionControl).toHaveBeenLastCalledWith("s1", "rewindFiles", {
      userMessageId: "u-1",
      options: { dryRun: false },
    })
  })

  it("omits toolUseId entirely when backgrounding everything", async () => {
    // `{ toolUseId: undefined }` and no params mean the same thing to the SDK,
    // but only the latter survives JSON without a null appearing on the wire.
    const deps = makeDeps()
    const handle = createAgentExecutionHandle("s1", withControls(), deps)

    await handle.backgroundTasks()
    expect(deps.ipc.sessionControl).toHaveBeenLastCalledWith("s1", "backgroundTasks", undefined)

    await handle.backgroundTasks("tu-1")
    expect(deps.ipc.sessionControl).toHaveBeenLastCalledWith("s1", "backgroundTasks", {
      toolUseId: "tu-1",
    })
  })

  it("exposes the generic control() for methods with no named wrapper", async () => {
    const deps = makeDeps()
    const handle = createAgentExecutionHandle("s1", withControls(), deps)
    await expect(handle.control("getContextUsage")).resolves.toBe("control-result")
    expect(deps.ipc.sessionControl).toHaveBeenCalledWith("s1", "getContextUsage", undefined)
  })
})
