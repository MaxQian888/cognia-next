import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import type { AgentEventEnvelope } from "@cognia/agent-config-types/agent-execution"
import { computeSequenceDigest } from "@cognia/agent-config-types/canonical-session"
import type { PluginToolExecRequest, PluginToolExecResponse } from "@/lib/claude/plugin-tool-ipc"
import { computeToolSchemaDigest } from "@/packages/agent/src/agent-definition"
import { contentDigest } from "@/packages/agent/src/digest"
import type { PluginTool } from "@/types/plugin"
import { sandboxSessionRuntime } from "@/lib/sandbox/session-runtime"
import type { UnifiedTurnParams, UnifiedTurnResult } from "../runtime/unified-runtime"

import { DEFAULT_RESOLVED_CONFIG } from "../../config/schema"
import { createAgentRuntimeService } from "./runtime-service"
import type { AgentRpcServiceContext } from "./server"

const mockRegisteredPluginTools = new Map<string, PluginTool>()
const mockRegisterTool = jest.fn((_pluginId: string, tool: PluginTool) => {
  mockRegisteredPluginTools.set(tool.name, tool)
})
const mockUnregisterTool = jest.fn((toolName: string) => mockRegisteredPluginTools.delete(toolName))
/** Captured so a test can fire a hook from inside a turn and check attribution. */
const mockRegisteredHooks = new Map<string, Record<string, (...args: unknown[]) => unknown>>()
const mockRegisterHooks = jest.fn(
  (pluginId: string, hooks: Record<string, (...args: unknown[]) => unknown>) => {
    mockRegisteredHooks.set(pluginId, hooks)
  }
)
const mockUnregisterHooks = jest.fn((pluginId: string) => mockRegisteredHooks.delete(pluginId))

jest.mock("../../plugin/plugin-runtime", () => ({
  ensurePluginRuntime: jest.fn(async () => ({ ok: true })),
}))

jest.mock("@/lib/plugin/core/manager", () => ({
  getPluginManager: () => ({
    getRegistry: () => ({
      registerTool: mockRegisterTool,
      unregisterTool: mockUnregisterTool,
    }),
    getHooksManager: () => ({
      registerHooks: mockRegisterHooks,
      unregisterHooks: mockUnregisterHooks,
    }),
  }),
}))

jest.mock("@/stores/plugin-runtime", () => ({
  usePluginStore: {
    getState: () => ({
      registerPluginTool: jest.fn(),
      unregisterPluginTool: jest.fn(),
    }),
  },
}))

const context = {
  emit: jest.fn(async (..._args: Parameters<AgentRpcServiceContext["emit"]>) => undefined),
  requestClient: jest.fn(),
}

describe("createAgentRuntimeService", () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), "cognia-agent-rpc-"))
    context.emit.mockClear()
    context.requestClient.mockReset()
    mockRegisteredPluginTools.clear()
    mockRegisterTool.mockClear()
    mockUnregisterTool.mockClear()
    mockRegisteredHooks.clear()
    mockRegisterHooks.mockClear()
    mockUnregisterHooks.mockClear()
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it("creates, runs, streams, reads, branches, and closes canonical sessions", async () => {
    const envelope = {
      schemaVersion: 1 as const,
      eventId: "event-1",
      sequence: 1,
      sessionId: "session-1",
      runId: "run-1",
      attemptId: "attempt-1",
      turnId: "turn-1",
      timestamp: new Date(0).toISOString(),
      hostRef: "test",
      runtime: "builtin",
      event: { kind: "lifecycle", phase: "started" },
    } satisfies AgentEventEnvelope
    const runTurn = jest.fn(async (params: UnifiedTurnParams): Promise<UnifiedTurnResult> => {
      params.onEnvelope?.(envelope)
      return {
        result: {
          schemaVersion: 1 as const,
          type: "result" as const,
          status: "completed" as const,
          sessionId: params.sessionId ?? "session-1",
          runId: "run-1",
          turnId: "turn-1",
          attemptId: "attempt-1",
          text: "done",
          backend: "builtin",
          model: "test-model",
          capabilities: ["session.resume"],
          session: { persisted: true, turnCount: 0 },
        },
        envelopes: [envelope],
      }
    })
    const service = createAgentRuntimeService({
      config: { ...DEFAULT_RESOLVED_CONFIG, cwd: home, model: "test-model" },
      home,
      runTurn,
      mintSessionId: () => "session-1",
    })

    const created = await service.handle("session/create", { name: "SDK" }, context as never)
    const outcome = await service.handle(
      "turn/run",
      { sessionId: "session-1", input: "hello", commandId: "run-command" },
      context as never
    )
    const state = await service.handle(
      "session/state",
      { sessionId: "session-1" },
      context as never
    )
    const fork = await service.handle(
      "session/fork",
      { sessionId: "session-1", name: "forked", commandId: "fork-command" },
      context as never
    )

    expect(created).toMatchObject({
      sessionId: "session-1",
      spec: {
        specVersion: 2,
        runtimeAdapter: "claude-agent-sdk",
        modelBindings: { primary: "test-model" },
        identity: { sessionId: "session-1", runId: "session-1" },
      },
    })
    expect(outcome).toMatchObject({ status: "completed", result: { text: "done" } })
    expect(state).toMatchObject({ sessionId: "session-1", status: "idle" })
    expect(fork.sessionId).not.toBe("session-1")
    expect(context.emit).toHaveBeenCalledWith("agent/event", {
      sessionId: "session-1",
      envelope,
    })

    await service.handle(
      "session/close",
      { sessionId: "session-1", commandId: "close-command" },
      context as never
    )
    await service.close()
  })

  it("rejects a concurrent run and returns the original command receipt on duplicates", async () => {
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const runTurn = jest.fn(async (params: UnifiedTurnParams): Promise<UnifiedTurnResult> => {
      await blocked
      return {
        result: {
          schemaVersion: 1 as const,
          type: "result" as const,
          status: "completed" as const,
          sessionId: params.sessionId ?? "session-1",
          runId: "run-1",
          turnId: "turn-1",
          attemptId: "attempt-1",
          text: "done",
          backend: "builtin",
          model: "test-model",
          capabilities: [],
          session: { persisted: true },
        },
        envelopes: [],
      }
    })
    const service = createAgentRuntimeService({
      config: { ...DEFAULT_RESOLVED_CONFIG, cwd: home, model: "test-model" },
      home,
      runTurn,
      mintSessionId: () => "session-1",
    })
    await service.handle("session/create", {}, context as never)
    const firstRun = service.handle(
      "turn/run",
      { sessionId: "session-1", input: "one", commandId: "run-one" },
      context as never
    )

    await expect(
      service.handle(
        "turn/run",
        { sessionId: "session-1", input: "two", commandId: "run-two" },
        context as never
      )
    ).rejects.toMatchObject({ structuredError: { code: "session_busy" } })

    const firstRename = await service.handle(
      "session/rename",
      { sessionId: "session-1", name: "renamed", commandId: "rename-one" },
      context as never
    )
    const duplicateRename = await service.handle(
      "session/rename",
      { sessionId: "session-1", name: "ignored", commandId: "rename-one" },
      context as never
    )
    expect(duplicateRename).toEqual(firstRename)
    expect(duplicateRename).toMatchObject({ commandId: "rename-one" })

    release()
    await firstRun
    await service.close()
  })

  it("fails closed on unsupported handoff and deduplicates worker session creation", async () => {
    const handoff = {
      envelopeVersion: 1 as const,
      identity: {
        parentRunId: "run-parent",
        childRunId: "run-child",
        depth: 1,
        parentChain: ["run-parent"],
      },
      task: { prompt: "Implement the child task" },
      execution: { mode: "orchestrated" as const },
      resources: [{ kind: "repository", ref: "repository:project-1:repo-1" }],
      createdAt: "2026-08-12T00:00:00.000Z",
    }
    const unsupported = createAgentRuntimeService({
      config: { ...DEFAULT_RESOLVED_CONFIG, cwd: home, model: "test-model" },
      home,
    })
    await expect(
      unsupported.handle("session/create", { commandId: "lease-1", handoff }, context as never)
    ).rejects.toMatchObject({ structuredError: { code: "unsupported_capability" } })
    await unsupported.close()

    const resolveHandoffWorkspace = jest.fn(async () => path.join(home, "isolated-workspace"))
    const workerManifest = {
      manifestVersion: 1 as const,
      runtime: "builtin",
      models: ["test-model"],
      hardCapabilities: ["filesystem.write"],
      maxActiveTurns: 1,
      credentialProfileRefs: ["credential:test"],
      workspaceBindingRefs: ["repository:project-1:repo-1"],
      taskWorkspace: { enabled: true },
      sandbox: { capabilities: ["filesystem.write"] },
      platform: { os: "linux", arch: "x64" },
    }
    const validateHandoffExecution = jest.fn()
    const worker = createAgentRuntimeService({
      config: { ...DEFAULT_RESOLVED_CONFIG, cwd: home, model: "test-model" },
      home,
      mintSessionId: () => "remote-session-1",
      workerDispatch: {
        manifest: workerManifest,
        resolveHandoffWorkspace,
        validateHandoffExecution,
      },
    })

    const first = await worker.handle(
      "session/create",
      { commandId: "lease-2", handoff },
      context as never
    )
    const duplicate = await worker.handle(
      "session/create",
      { commandId: "lease-2", handoff },
      context as never
    )

    expect(duplicate).toEqual(first)
    expect(first).toMatchObject({ sessionId: "remote-session-1", commandId: "lease-2" })
    expect(resolveHandoffWorkspace).toHaveBeenCalledTimes(1)
    validateHandoffExecution.mockImplementationOnce(() => {
      throw new Error("worker execution profile changed")
    })
    await expect(
      worker.handle(
        "turn/run",
        { sessionId: "remote-session-1", input: "start", commandId: "turn-1" },
        context as never
      )
    ).rejects.toThrow("worker execution profile changed")
    expect(validateHandoffExecution).toHaveBeenCalledWith(handoff)
    await worker.close()

    const restarted = createAgentRuntimeService({
      config: { ...DEFAULT_RESOLVED_CONFIG, cwd: home, model: "test-model" },
      home,
      mintSessionId: () => "must-not-create-another-session",
      workerDispatch: { manifest: workerManifest, resolveHandoffWorkspace },
    })
    await expect(
      restarted.handle("session/create", { commandId: "lease-2", handoff }, context as never)
    ).resolves.toEqual(first)
    expect(resolveHandoffWorkspace).toHaveBeenCalledTimes(1)
    await restarted.close()
  })

  it("persists tags and command receipts across host restarts", async () => {
    const config = { ...DEFAULT_RESOLVED_CONFIG, cwd: home, model: "test-model" }
    const first = createAgentRuntimeService({
      config,
      home,
      mintSessionId: () => "session-1",
    })
    await first.handle("session/create", { tags: ["sdk", "sdk"] }, context as never)
    const receipt = await first.handle(
      "session/tag",
      { sessionId: "session-1", tags: ["durable"], commandId: "tag-one" },
      context as never
    )

    const restarted = createAgentRuntimeService({ config, home })
    const duplicate = await restarted.handle(
      "session/tag",
      { sessionId: "session-1", tags: ["ignored"], commandId: "tag-one" },
      context as never
    )
    const state = await restarted.handle(
      "session/state",
      { sessionId: "session-1" },
      context as never
    )

    expect(duplicate).toEqual(receipt)
    expect(state).toMatchObject({ tags: ["durable"], recoveryRequired: false })
    await first.close()
    await restarted.close()
  })

  it("imports, exports, and deletes canonical sessions without bypassing the store", async () => {
    const service = createAgentRuntimeService({
      config: { ...DEFAULT_RESOLVED_CONFIG, cwd: home, model: "test-model" },
      home,
    })
    const turns = [
      { turnId: "turn-1:user", role: "user" as const, text: "hello" },
      { turnId: "turn-1:assistant", role: "assistant" as const, text: "hi" },
    ]
    const imported = await service.handle(
      "session/import",
      {
        session: {
          header: {
            canonicalVersion: 1,
            canonicalSessionId: "imported-1",
            sourceRuntime: "external",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            turnCount: turns.length,
            importFidelity: "structured",
            sequenceDigest: computeSequenceDigest(turns),
          },
          turns,
        },
      },
      context as never
    )
    const exported = await service.handle(
      "session/export",
      { sessionId: imported.sessionId },
      context as never
    )
    expect(
      (exported.turns as Array<{ role: string; text: string }>).map(({ role, text }) => ({
        role,
        text,
      }))
    ).toEqual([
      { role: "user", text: "hello" },
      { role: "assistant", text: "hi" },
    ])

    const deleted = await service.handle(
      "session/delete",
      { sessionId: imported.sessionId, commandId: "delete-one" },
      context as never
    )
    expect(deleted).toMatchObject({ deleted: true, commandId: "delete-one" })
    await expect(
      service.handle("session/open", { sessionId: imported.sessionId }, context as never)
    ).rejects.toMatchObject({ structuredError: { code: "session_not_found" } })
    await service.close()
  })

  it("returns a real compaction boundary and restores its live undo snapshot once", async () => {
    let onCompactionEvent: ((payload: unknown) => void) | undefined
    const unsubscribe = jest.fn()
    const restore = jest.fn(async () => undefined)
    const compact = jest.fn(async (sessionId: string, _focus?: string) => {
      onCompactionEvent?.({
        type: "event",
        sessionId,
        event: {
          type: "system",
          subtype: "compact_boundary",
          uuid: "boundary-1",
          compact_metadata: { pre_messages: [{ role: "user", content: "before" }] },
        },
      })
    })
    const closeLease = jest.fn(async () => undefined)
    const service = createAgentRuntimeService({
      config: { ...DEFAULT_RESOLVED_CONFIG, cwd: home, model: "test-model" },
      home,
      mintSessionId: () => "session-1",
      createLease: () =>
        ({
          current: { isLive: () => true },
          openKey: "live",
          session: jest.fn(),
          replace: jest.fn(),
          close: closeLease,
        }) as never,
      subscribeCompactionEvents: async (handler) => {
        onCompactionEvent = handler
        return unsubscribe
      },
      compact: compact as never,
      restore,
    })
    await service.handle("session/create", {}, context as never)

    await expect(
      service.handle(
        "session/compact",
        {
          sessionId: "session-1",
          instructions: "Preserve alice@example.com",
          commandId: "compact-unsafe",
        },
        context as never
      )
    ).rejects.toMatchObject({ structuredError: { code: "permission_denied" } })
    expect(compact).not.toHaveBeenCalled()

    await expect(
      service.handle(
        "session/compact",
        { sessionId: "session-1", instructions: "preserve decisions", commandId: "compact-one" },
        context as never
      )
    ).resolves.toEqual({
      accepted: true,
      commandId: "compact-one",
      undoAvailable: true,
      boundaryId: "compact-boundary-1",
    })
    expect(compact).toHaveBeenCalledWith("session-1", "preserve decisions", {
      commandId: "compact-one",
    })
    expect(unsubscribe).toHaveBeenCalledTimes(1)

    await expect(
      service.handle(
        "session/compact/undo",
        {
          sessionId: "session-1",
          boundaryId: "compact-boundary-1",
          commandId: "undo-one",
        },
        context as never
      )
    ).resolves.toEqual({ accepted: true, commandId: "undo-one" })
    expect(restore).toHaveBeenCalledWith("session-1", [{ role: "user", content: "before" }])
    await expect(
      service.handle(
        "session/compact/undo",
        {
          sessionId: "session-1",
          boundaryId: "compact-boundary-1",
          commandId: "undo-two",
        },
        context as never
      )
    ).rejects.toMatchObject({ structuredError: { code: "unsupported_capability" } })
    await service.close()
    expect(closeLease).toHaveBeenCalledTimes(1)
  })

  it("validates MCP configuration before a session is live and injects it into the next turn", async () => {
    const runTurn = jest.fn(async (params: UnifiedTurnParams): Promise<UnifiedTurnResult> => {
      expect(await params.resolveMcpServers?.()).toEqual([
        expect.objectContaining({ id: "mcp-1", name: "local", transport: "stdio" }),
      ])
      return {
        result: {
          schemaVersion: 1,
          type: "result",
          status: "completed",
          sessionId: params.sessionId ?? "session-1",
          runId: "run-1",
          turnId: "turn-1",
          attemptId: "attempt-1",
          text: "done",
          backend: "builtin",
          model: "test-model",
          capabilities: [],
          session: { persisted: true },
        },
        envelopes: [],
      }
    })
    const service = createAgentRuntimeService({
      config: { ...DEFAULT_RESOLVED_CONFIG, cwd: home, model: "test-model" },
      home,
      runTurn,
      mintSessionId: () => "session-1",
    })
    const server = {
      id: "mcp-1",
      name: "local",
      displayName: "Local",
      transport: "stdio",
      config: { command: "node", args: ["server.mjs"] },
      enabled: true,
      schemaVersion: 1,
      revision: 1,
      credentialVersion: 0,
      origin: "manual",
      trust: { state: "trusted" },
      createdAt: 1,
      updatedAt: 1,
    }

    await expect(
      service.handle("mcp/configure", { servers: [server] }, context as never)
    ).resolves.toEqual({ configured: 1, applied: {} })
    await service.handle("session/create", {}, context as never)
    await service.handle(
      "turn/run",
      { sessionId: "session-1", input: "use MCP", commandId: "run-with-mcp" },
      context as never
    )
    expect(runTurn).toHaveBeenCalledTimes(1)
    await service.close()
  })

  it("snapshots and restores the effective sandbox policy", async () => {
    const sessionRoot = path.join(home, "sessions")
    const statePath = path.join(sessionRoot, "session-1", "rpc-state.json")
    mkdirSync(path.dirname(statePath), { recursive: true })
    writeFileSync(
      statePath,
      JSON.stringify({
        sandboxPolicy: {
          network: "off",
          writableRoots: [home],
          maxMemoryMb: 512,
        },
      })
    )
    const service = createAgentRuntimeService({
      config: { ...DEFAULT_RESOLVED_CONFIG, cwd: home, model: "test-model" },
      home,
      sessionDirOverride: sessionRoot,
      mintSessionId: () => "session-1",
    })
    await service.handle("session/create", {}, context as never)
    const policyRecord = await service.handle(
      "sandbox/policy/capture",
      { sessionId: "session-1", commandId: "snapshot-one" },
      context as never
    )
    const changedState = JSON.parse(readFileSync(statePath, "utf8")) as {
      sandboxPolicy: Record<string, unknown> | null
    }
    changedState.sandboxPolicy = { network: "on" }
    writeFileSync(statePath, JSON.stringify(changedState))

    await service.handle(
      "sandbox/policy/restore",
      {
        sessionId: "session-1",
        policyRecordId: String(policyRecord.policyRecordId),
        commandId: "restore-one",
      },
      context as never
    )
    expect(
      await service.handle("sandbox/status", { sessionId: "session-1" }, context as never)
    ).toMatchObject({
      enabled: true,
      snapshotCount: 1,
      policy: { network: "off", writableRoots: [home], maxMemoryMb: 512 },
    })
    await service.close()
  })

  it("binds the persisted ceiling before a turn can dispatch tools", async () => {
    const sessionRoot = path.join(home, "sessions")
    const statePath = path.join(sessionRoot, "session-1", "rpc-state.json")
    mkdirSync(path.dirname(statePath), { recursive: true })
    writeFileSync(
      statePath,
      JSON.stringify({ sandboxPolicy: { network: "off", writableRoots: [home] } })
    )
    const service = createAgentRuntimeService({
      config: { ...DEFAULT_RESOLVED_CONFIG, cwd: home, model: "test-model" },
      home,
      sessionDirOverride: sessionRoot,
      mintSessionId: () => "session-1",
      runTurn: async (params: UnifiedTurnParams): Promise<UnifiedTurnResult> => ({
        result: {
          schemaVersion: 1 as const,
          type: "result" as const,
          status: "completed" as const,
          sessionId: params.sessionId ?? "session-1",
          runId: "run-1",
          turnId: "turn-1",
          attemptId: "attempt-1",
          text: "done",
          backend: "builtin",
          model: "test-model",
          capabilities: ["session.resume"],
          session: { persisted: true, turnCount: 0 },
        },
        envelopes: [],
      }),
    })
    await service.handle("session/create", {}, context as never)
    await service.handle("turn/run", { sessionId: "session-1", input: "hi" }, context as never)

    // `plugin-tool-dispatch` resolves the placement synchronously by session
    // id, so the bind must have settled before the turn started — otherwise the
    // first tool call runs against the unpoliced host default.
    const ref = sandboxSessionRuntime.activeRefForSession("session-1")
    expect(ref).toBeDefined()
    expect(() => sandboxSessionRuntime.assertWritablePath(ref!, "/etc/passwd")).toThrow(
      /outside the configured writable roots/
    )
    // Computer Use is the host/local placement on this rail, not a refusal.
    await expect(sandboxSessionRuntime.decorateComputerUseContext(ref!, {})).resolves.toEqual({})
    await service.close()
  })

  it("reports a restore whose rebind failed instead of acknowledging it", async () => {
    const sessionRoot = path.join(home, "sessions")
    const service = createAgentRuntimeService({
      config: { ...DEFAULT_RESOLVED_CONFIG, cwd: home, model: "test-model" },
      home,
      sessionDirOverride: sessionRoot,
      mintSessionId: () => "session-1",
    })
    await service.handle("session/create", {}, context as never)
    const policyRecord = await service.handle(
      "sandbox/policy/capture",
      { sessionId: "session-1", commandId: "snapshot-one" },
      context as never
    )
    const bindSpy = jest
      .spyOn(sandboxSessionRuntime, "bindSession")
      .mockRejectedValueOnce(new Error("adapter refused"))

    try {
      await expect(
        service.handle(
          "sandbox/policy/restore",
          {
            sessionId: "session-1",
            policyRecordId: String(policyRecord.policyRecordId),
            commandId: "restore-one",
          },
          context as never
        )
      ).rejects.toThrow(/could not be bound/)
    } finally {
      bindSpy.mockRestore()
    }
    await service.close()
  })

  it("streams redacted RPC traces and queries durable audit records", async () => {
    const service = createAgentRuntimeService({
      config: { ...DEFAULT_RESOLVED_CONFIG, cwd: home, model: "test-model" },
      home,
      mintSessionId: () => "session-1",
      now: (() => {
        let value = 1_000
        return () => (value += 5)
      })(),
    })
    await service.handle("session/create", {}, context as never)
    const subscription = await service.handle(
      "trace/subscribe",
      { sessionId: "session-1" },
      context as never
    )
    await service.handle("session/state", { sessionId: "session-1" }, context as never)
    await new Promise((resolve) => setImmediate(resolve))

    // Audit rows no longer masquerade as spans on the trace stream.
    const traceEvents = context.emit.mock.calls.filter(([method]) => method === "trace/event")
    expect(traceEvents).toHaveLength(0)
    void subscription
    const audit = await service.handle(
      "audit/query",
      { sessionId: "session-1", limit: 100 },
      context as never
    )
    expect((audit.entries as Array<{ method: string }>).map((entry) => entry.method)).toEqual(
      expect.arrayContaining(["trace/subscribe", "session/state"])
    )
    expect(JSON.stringify(audit)).not.toContain("prompt")
    expect(
      await service.handle(
        "trace/export",
        { sessionId: "session-1", format: "json" },
        context as never
      )
    ).toMatchObject({ redacted: true, format: "json", spans: expect.any(Array) })
    await service.close()
  })

  it("routes ask_user through durable RPC elicitation settlement", async () => {
    let handler!: (request: PluginToolExecRequest) => Promise<PluginToolExecResponse>
    let raised!: () => void
    const elicitationRaised = new Promise<void>((resolve) => {
      raised = resolve
    })
    const runTurn = jest.fn(async (params: UnifiedTurnParams): Promise<UnifiedTurnResult> => {
      const unsubscribe = await params.subscribePluginTools?.()
      raised()
      const response = await handler({
        type: "plugin_tool_exec",
        sessionId: params.sessionId ?? "session-1",
        toolUseId: "question-1",
        name: "ask_user",
        args: {
          question: "Continue?",
          options: [{ value: "yes", label: "Yes" }],
        },
      })
      unsubscribe?.()
      return {
        result: {
          schemaVersion: 1,
          type: "result",
          status: "completed",
          sessionId: params.sessionId ?? "session-1",
          runId: "run-1",
          turnId: "turn-1",
          attemptId: "attempt-1",
          text: String(response.result),
          backend: "builtin",
          model: "test-model",
          capabilities: [],
          session: { persisted: true },
        },
        envelopes: [],
      }
    })
    const service = createAgentRuntimeService({
      config: { ...DEFAULT_RESOLVED_CONFIG, cwd: home, model: "test-model" },
      home,
      runTurn,
      mintSessionId: () => "session-1",
      subscribePluginTools: async (nextHandler) => {
        handler = nextHandler
        return () => undefined
      },
    })
    await service.handle("session/create", {}, context as never)
    const turn = service.handle(
      "turn/run",
      { sessionId: "session-1", input: "ask", commandId: "run-one" },
      context as never
    )
    await elicitationRaised
    await new Promise((resolve) => setImmediate(resolve))
    expect(
      await service.handle("session/state", { sessionId: "session-1" }, context as never)
    ).toMatchObject({
      status: "waiting",
      pendingElicitations: [{ requestId: "question-1", prompt: "Continue?" }],
    })

    await service.handle(
      "elicitation/respond",
      {
        sessionId: "session-1",
        requestId: "question-1",
        response: { kind: "submit", value: { selected: ["yes"], text: "" } },
        commandId: "answer-one",
      },
      context as never
    )
    await expect(turn).resolves.toMatchObject({
      status: "completed",
      result: { text: "Selected: Yes" },
    })
    await service.close()
  })

  it("surfaces unresolved permissions as recovery-required after restart", async () => {
    let permissionRequested!: () => void
    const requested = new Promise<void>((resolve) => {
      permissionRequested = resolve
    })
    let runCount = 0
    const runTurn = jest.fn(async (params: UnifiedTurnParams): Promise<UnifiedTurnResult> => {
      runCount += 1
      if (runCount === 2) {
        expect(params.prompt).toBe("write")
        expect(params.recoveryIdentity).toEqual({
          runId: "run-1",
          turnId: "turn-1",
          attempt: 1,
        })
        await expect(
          params.gate({
            type: "permission_request",
            sessionId: params.sessionId ?? "session-1",
            requestId: "permission-replayed",
            toolUseID: "tool-use-replayed",
            toolName: "write_file",
            input: { path: "a.txt" },
          })
        ).resolves.toEqual({ decision: "deny", message: "restart-safe" })
        return {
          result: {
            schemaVersion: 1,
            type: "result",
            status: "completed",
            sessionId: params.sessionId ?? "session-1",
            runId: "run-1",
            turnId: "turn-1",
            attemptId: "turn-1:a1",
            text: "resumed",
            backend: "builtin",
            model: "test-model",
            capabilities: ["session.resume"],
            session: { persisted: true },
          },
          envelopes: [],
        }
      }
      params.onEnvelope?.({
        schemaVersion: 1,
        eventId: "session-1:turn-1:turn-1:a0:0",
        sequence: 0,
        sessionId: params.sessionId ?? "session-1",
        runId: "run-1",
        turnId: "turn-1",
        attemptId: "turn-1:a0",
        hostRef: "test",
        runtime: "builtin",
        timestamp: new Date(0).toISOString(),
        event: { kind: "lifecycle", phase: "started" },
      })
      permissionRequested()
      await params.gate({
        type: "permission_request",
        sessionId: params.sessionId ?? "session-1",
        requestId: "permission-1",
        toolUseID: "tool-use-1",
        toolName: "write_file",
        input: { path: "a.txt" },
      })
      throw new Error("host stopped")
    })
    const config = { ...DEFAULT_RESOLVED_CONFIG, cwd: home, model: "test-model" }
    const first = createAgentRuntimeService({
      config,
      home,
      runTurn,
      mintSessionId: () => "session-1",
    })
    await first.handle("session/create", {}, context as never)
    void Promise.resolve(
      first.handle(
        "turn/run",
        { sessionId: "session-1", input: "write", commandId: "run-one" },
        context as never
      )
    ).catch(() => undefined)
    await requested
    await new Promise((resolve) => setImmediate(resolve))

    await first.close()

    const restarted = createAgentRuntimeService({ config, home, runTurn })
    const state = await restarted.handle(
      "session/state",
      { sessionId: "session-1" },
      context as never
    )
    expect(state).toMatchObject({
      status: "recovery_required",
      recoveryRequired: true,
      pendingPermissions: [{ requestId: "permission-1", toolName: "write_file" }],
    })
    await expect(
      restarted.handle(
        "turn/run",
        { sessionId: "session-1", input: "again", commandId: "run-two" },
        context as never
      )
    ).rejects.toMatchObject({ structuredError: { code: "recovery_required" } })

    const settled = await restarted.handle(
      "permission/respond",
      {
        sessionId: "session-1",
        requestId: "permission-1",
        decision: { kind: "reject", reason: "restart-safe" },
        commandId: "permission-command",
      },
      context as never
    )
    expect(settled).toMatchObject({ recovered: true, resumeScheduled: true })
    await restarted.handle(
      "turn/wait",
      { sessionId: "session-1", timeoutMs: 1_000 },
      context as never
    )
    expect(runTurn).toHaveBeenCalledTimes(2)
    expect(
      await restarted.handle("session/state", { sessionId: "session-1" }, context as never)
    ).toMatchObject({ status: "idle", recoveryRequired: false, pendingPermissions: [] })

    await restarted.close()
  })

  it("replays a recovered client-tool result after a host restart", async () => {
    let runCount = 0
    const runTurn = jest.fn(async (params: UnifiedTurnParams): Promise<UnifiedTurnResult> => {
      runCount += 1
      params.onEnvelope?.({
        schemaVersion: 1,
        eventId: `session-1:turn-1:turn-1:a${runCount - 1}:0`,
        sequence: 0,
        sessionId: params.sessionId ?? "session-1",
        runId: "run-1",
        turnId: "turn-1",
        attemptId: `turn-1:a${runCount - 1}`,
        hostRef: "test",
        runtime: "builtin",
        timestamp: new Date(0).toISOString(),
        event: { kind: "lifecycle", phase: "started" },
      })
      const tool = mockRegisteredPluginTools.get("save_record")
      expect(tool).toBeDefined()
      const output = await tool!.execute(
        { id: "record-1" },
        {
          sessionId: params.sessionId,
          messageId: runCount === 1 ? "tool-call-1" : "tool-call-replayed",
          config: {},
        }
      )
      return {
        result: {
          schemaVersion: 1,
          type: "result",
          status: "completed",
          sessionId: params.sessionId ?? "session-1",
          runId: "run-1",
          turnId: "turn-1",
          attemptId: `turn-1:a${runCount - 1}`,
          text: JSON.stringify(output),
          backend: "builtin",
          model: "test-model",
          capabilities: ["session.resume"],
          session: { persisted: true },
        },
        envelopes: [],
      }
    })
    context.requestClient.mockRejectedValueOnce(new Error("host stopped"))
    const config = { ...DEFAULT_RESOLVED_CONFIG, cwd: home, model: "test-model" }
    const registration = {
      handlerId: "save-handler",
      name: "save_record",
      description: "Save one record",
      inputSchema: { type: "object" },
      sideEffect: "idempotent" as const,
    }
    const first = createAgentRuntimeService({
      config,
      home,
      runTurn,
      mintSessionId: () => "session-1",
    })
    await first.handle("session/create", {}, context as never)
    await first.handle("tool/register", registration, context as never)
    await expect(
      first.handle(
        "turn/run",
        { sessionId: "session-1", input: "save", commandId: "run-one" },
        context as never
      )
    ).rejects.toThrow("host stopped")
    await first.close()

    const restarted = createAgentRuntimeService({ config, home, runTurn })
    await restarted.handle("tool/register", registration, context as never)
    expect(
      await restarted.handle("session/state", { sessionId: "session-1" }, context as never)
    ).toMatchObject({
      status: "recovery_required",
      pendingExternalTools: [{ requestId: "tool-call-1", toolName: "save_record" }],
    })

    const settled = await restarted.handle(
      "externalTool/respond",
      {
        sessionId: "session-1",
        requestId: "tool-call-1",
        response: { kind: "result", value: { saved: true } },
        commandId: "tool-response-one",
      },
      context as never
    )
    expect(settled).toMatchObject({ recovered: true, resumeScheduled: true })
    await restarted.handle(
      "turn/wait",
      { sessionId: "session-1", timeoutMs: 1_000 },
      context as never
    )
    expect(runTurn).toHaveBeenCalledTimes(2)
    expect(context.requestClient).toHaveBeenCalledTimes(1)
    expect(
      await restarted.handle("session/state", { sessionId: "session-1" }, context as never)
    ).toMatchObject({ status: "idle", recoveryRequired: false, pendingExternalTools: [] })
    await restarted.close()
  })

  it("resumes a suspended elicitation with the stored response after restart", async () => {
    let handler!: (request: PluginToolExecRequest) => Promise<PluginToolExecResponse>
    let elicitationRequested!: () => void
    const requested = new Promise<void>((resolve) => {
      elicitationRequested = resolve
    })
    let runCount = 0
    const askArgs = {
      question: "Continue?",
      options: [{ value: "yes", label: "Yes" }],
    }
    const runTurn = jest.fn(async (params: UnifiedTurnParams): Promise<UnifiedTurnResult> => {
      runCount += 1
      params.onEnvelope?.({
        schemaVersion: 1,
        eventId: `session-1:turn-1:turn-1:a${runCount - 1}:0`,
        sequence: 0,
        sessionId: params.sessionId ?? "session-1",
        runId: "run-1",
        turnId: "turn-1",
        attemptId: `turn-1:a${runCount - 1}`,
        hostRef: "test",
        runtime: "builtin",
        timestamp: new Date(0).toISOString(),
        event: { kind: "lifecycle", phase: "started" },
      })
      const unsubscribe = await params.subscribePluginTools?.()
      if (runCount === 1) elicitationRequested()
      else {
        expect(params.recoveryIdentity).toEqual({ runId: "run-1", turnId: "turn-1", attempt: 1 })
      }
      const response = await handler({
        type: "plugin_tool_exec",
        sessionId: params.sessionId ?? "session-1",
        toolUseId: runCount === 1 ? "question-1" : "question-replayed",
        name: "ask_user",
        args: askArgs,
      })
      unsubscribe?.()
      if (runCount === 1) throw new Error("host stopped")
      expect(response.result).toBe("Selected: Yes")
      return {
        result: {
          schemaVersion: 1,
          type: "result",
          status: "completed",
          sessionId: params.sessionId ?? "session-1",
          runId: "run-1",
          turnId: "turn-1",
          attemptId: "turn-1:a1",
          text: String(response.result),
          backend: "builtin",
          model: "test-model",
          capabilities: ["session.resume"],
          session: { persisted: true },
        },
        envelopes: [],
      }
    })
    const config = { ...DEFAULT_RESOLVED_CONFIG, cwd: home, model: "test-model" }
    const subscribePluginTools = async (
      nextHandler: (request: PluginToolExecRequest) => Promise<PluginToolExecResponse>
    ) => {
      handler = nextHandler
      return () => undefined
    }
    const first = createAgentRuntimeService({
      config,
      home,
      runTurn,
      mintSessionId: () => "session-1",
      subscribePluginTools,
    })
    await first.handle("session/create", {}, context as never)
    void Promise.resolve(
      first.handle(
        "turn/run",
        { sessionId: "session-1", input: "ask", commandId: "run-one" },
        context as never
      )
    ).catch(() => undefined)
    await requested
    await new Promise((resolve) => setImmediate(resolve))
    await first.close()

    const restarted = createAgentRuntimeService({ config, home, runTurn, subscribePluginTools })
    expect(
      await restarted.handle("session/state", { sessionId: "session-1" }, context as never)
    ).toMatchObject({
      status: "recovery_required",
      pendingElicitations: [{ requestId: "question-1", prompt: "Continue?" }],
    })
    await expect(
      restarted.handle(
        "elicitation/respond",
        {
          sessionId: "session-1",
          requestId: "question-1",
          response: { kind: "submit", value: { selected: ["yes"], text: "" } },
          commandId: "answer-one",
        },
        context as never
      )
    ).resolves.toMatchObject({ recovered: true, resumeScheduled: true })
    await restarted.handle(
      "turn/wait",
      { sessionId: "session-1", timeoutMs: 1_000 },
      context as never
    )
    expect(runTurn).toHaveBeenCalledTimes(2)
    expect(
      await restarted.handle("session/state", { sessionId: "session-1" }, context as never)
    ).toMatchObject({ status: "idle", recoveryRequired: false, pendingElicitations: [] })
    await restarted.close()
  })
  // ---- ADR-0142 Phase 1: replay bounds, subtree scoping, releasable traces ----

  /** Minimal turn that emits `count` envelopes and completes. */
  function emittingTurn(count: number, sessionId = "session-1") {
    return jest.fn(async (params: UnifiedTurnParams): Promise<UnifiedTurnResult> => {
      const envelopes: AgentEventEnvelope[] = []
      for (let index = 0; index < count; index += 1) {
        const envelope = {
          schemaVersion: 1 as const,
          eventId: `${sessionId}:turn-1:attempt-1:${index}`,
          sequence: index,
          sessionId,
          runId: "run-1",
          attemptId: "attempt-1",
          turnId: "turn-1",
          timestamp: new Date(index).toISOString(),
          hostRef: "test",
          runtime: "builtin",
          event: { kind: "lifecycle", phase: "started" },
        } satisfies AgentEventEnvelope
        envelopes.push(envelope)
        params.onEnvelope?.(envelope)
      }
      // The real runtime persists as it emits; the mock has to do the same or
      // there is no event log for `session/entries` to page.
      if (envelopes.length > 0 && params.store) {
        const handle = params.store.open(sessionId, { writable: true })
        if (handle.ok) {
          handle.value.append(envelopes)
          handle.value.close()
        }
      }
      return {
        result: {
          schemaVersion: 1 as const,
          type: "result" as const,
          status: "completed" as const,
          sessionId: params.sessionId ?? sessionId,
          runId: "run-1",
          turnId: "turn-1",
          attemptId: "attempt-1",
          text: "done",
          backend: "builtin",
          model: "test-model",
          capabilities: [],
          session: { persisted: true, turnCount: 1 },
        },
        envelopes,
      }
    })
  }

  function makeService(runTurn: ReturnType<typeof emittingTurn>, mintSessionId?: () => string) {
    return createAgentRuntimeService({
      config: { ...DEFAULT_RESOLVED_CONFIG, cwd: home, model: "test-model" },
      home,
      runTurn,
      ...(mintSessionId ? { mintSessionId } : {}),
    })
  }

  it("reports the head cursor on every entries page so replay can be bounded", async () => {
    const service = makeService(emittingTurn(3), () => "session-1")
    await service.handle("session/create", {}, context as never)
    await service.handle(
      "turn/run",
      { sessionId: "session-1", input: "go", commandId: "run-1" },
      context as never
    )

    const firstPage = (await service.handle(
      "session/entries",
      { sessionId: "session-1", limit: 1 },
      context as never
    )) as { entries: unknown[]; nextEventId?: string; headEventId?: string }

    expect(firstPage.entries).toHaveLength(1)
    // The head is the newest persisted event, not the end of this page.
    expect(firstPage.headEventId).toBe("session-1:turn-1:attempt-1:2")
    expect(firstPage.nextEventId).toBe("session-1:turn-1:attempt-1:0")

    const full = (await service.handle(
      "session/entries",
      { sessionId: "session-1" },
      context as never
    )) as { entries: unknown[]; headEventId?: string; nextEventId?: string }
    expect(full.entries).toHaveLength(3)
    expect(full.headEventId).toBe("session-1:turn-1:attempt-1:2")
    expect(full.nextEventId).toBeUndefined()
    await service.close()
  })

  it("omits the head cursor for a session that has no events yet", async () => {
    const service = makeService(emittingTurn(0), () => "session-1")
    await service.handle("session/create", {}, context as never)
    const page = (await service.handle(
      "session/entries",
      { sessionId: "session-1" },
      context as never
    )) as { entries: unknown[]; headEventId?: string }
    expect(page.entries).toEqual([])
    expect(page.headEventId).toBeUndefined()
    await service.close()
  })

  it("clamps an oversized entries limit to the announced replay ceiling", async () => {
    const service = makeService(emittingTurn(2), () => "session-1")
    await service.handle("session/create", {}, context as never)
    await service.handle(
      "turn/run",
      { sessionId: "session-1", input: "go", commandId: "run-1" },
      context as never
    )
    const page = (await service.handle(
      "session/entries",
      { sessionId: "session-1", limit: 10_000 },
      context as never
    )) as { entries: unknown[] }
    expect(page.entries).toHaveLength(2)
    await service.close()
  })

  it("scopes session/tree to one subtree and keeps the forest on session/forest", async () => {
    let next = 0
    const ids = ["session-a", "session-b"]
    const service = makeService(emittingTurn(0), () => ids[next++] ?? `session-${next}`)
    await service.handle("session/create", { name: "a" }, context as never)
    await service.handle("session/create", { name: "b" }, context as never)
    const forked = (await service.handle(
      "session/fork",
      { sessionId: "session-a", name: "a-fork", commandId: "fork-1" },
      context as never
    )) as { sessionId: string }

    const subtree = (await service.handle(
      "session/tree",
      { sessionId: "session-a" },
      context as never
    )) as { roots: { sessionId: string; children: { sessionId: string }[] }[] }
    expect(subtree.roots).toHaveLength(1)
    expect(subtree.roots[0]!.sessionId).toBe("session-a")
    expect(subtree.roots[0]!.children.map((child) => child.sessionId)).toEqual([forked.sessionId])

    const forest = (await service.handle("session/forest", {}, context as never)) as {
      roots: { sessionId: string }[]
    }
    expect(forest.roots.map((root) => root.sessionId).sort()).toEqual(["session-a", "session-b"])
    await service.close()
  })

  it("refuses a tree request for a session it does not have", async () => {
    const service = makeService(emittingTurn(0), () => "session-1")
    await expect(
      service.handle("session/tree", { sessionId: "nope" }, context as never)
    ).rejects.toMatchObject({ structuredError: { code: "session_not_found" } })
    await service.close()
  })

  it("stops delivering spans once a trace subscription is released", async () => {
    const service = makeService(emittingTurn(0), () => "session-1")
    const subscribed = (await service.handle("trace/subscribe", {}, context as never)) as {
      subscriptionId: string
    }
    await service.handle("session/create", {}, context as never)
    await service.handle(
      "turn/run",
      { sessionId: "session-1", input: "go", commandId: "run-1" },
      context as never
    )
    await new Promise((resolve) => setImmediate(resolve))
    const delivered = context.emit.mock.calls.filter(([method]) => method === "trace/event")
    expect(delivered.length).toBeGreaterThan(0)
    // Redacted by default: no prompt or completion text on the wire.
    const span = (delivered[0]![1] as { span: Record<string, unknown> }).span
    expect(span).toMatchObject({ operationName: "invoke_agent", surface: "agent-rpc" })
    expect(span.inputPreview).toBeUndefined()
    expect(span.outputPreview).toBeUndefined()
    expect(span.metadata).toMatchObject({ redacted: true })

    await expect(
      service.handle(
        "trace/unsubscribe",
        { subscriptionId: subscribed.subscriptionId },
        context as never
      )
    ).resolves.toEqual({ ok: true })

    context.emit.mockClear()
    await service.handle(
      "turn/run",
      { sessionId: "session-1", input: "again", commandId: "run-2" },
      context as never
    )
    await new Promise((resolve) => setImmediate(resolve))
    expect(context.emit.mock.calls.filter(([method]) => method === "trace/event")).toHaveLength(0)
    await service.close()
  })

  it("hands content to a subscriber that opted in, through the PII gate", async () => {
    const service = makeService(emittingTurn(0), () => "session-1")
    await service.handle("trace/subscribe", { includeContent: true }, context as never)
    await service.handle("session/create", {}, context as never)
    await service.handle(
      "turn/run",
      { sessionId: "session-1", input: "summarise the changelog", commandId: "run-1" },
      context as never
    )
    await new Promise((resolve) => setImmediate(resolve))
    const delivered = context.emit.mock.calls.filter(([method]) => method === "trace/event")
    const span = (delivered.at(-1)![1] as { span: Record<string, unknown> }).span
    expect(span.inputPreview).toBe("summarise the changelog")
    await service.close()
  })

  it("drops a preview that fails the PII gate even when content was requested", async () => {
    const service = makeService(emittingTurn(0), () => "session-1")
    await service.handle("trace/subscribe", { includeContent: true }, context as never)
    await service.handle("session/create", {}, context as never)
    await service.handle(
      "turn/run",
      {
        sessionId: "session-1",
        input: "mail alice@example.com about the release",
        commandId: "run-1",
      },
      context as never
    )
    await new Promise((resolve) => setImmediate(resolve))
    const delivered = context.emit.mock.calls.filter(([method]) => method === "trace/event")
    const span = (delivered.at(-1)![1] as { span: Record<string, unknown> }).span
    expect(span.inputPreview).toBeUndefined()
    expect(span.metadata).toMatchObject({ inputPreviewBlocked: "pii-gate" })
    await service.close()
  })

  it("exports spans as JSON and as OTLP JSON", async () => {
    const service = makeService(emittingTurn(0), () => "session-1")
    await service.handle("session/create", {}, context as never)
    await service.handle(
      "turn/run",
      { sessionId: "session-1", input: "go", commandId: "run-1" },
      context as never
    )

    const json = (await service.handle(
      "trace/export",
      { sessionId: "session-1", format: "json" },
      context as never
    )) as { format: string; spans: unknown[]; redacted: boolean; audit: unknown }
    expect(json).toMatchObject({ format: "json", redacted: true })
    expect(json.spans.length).toBeGreaterThan(0)
    expect(json.audit).toBeDefined()

    const otlp = (await service.handle(
      "trace/export",
      { sessionId: "session-1", format: "otlp-json" },
      context as never
    )) as { format: string; resourceSpans?: unknown[] }
    expect(otlp.format).toBe("otlp-json")
    expect(Array.isArray(otlp.resourceSpans)).toBe(true)
    await service.close()
  })

  it("refuses an unknown trace export format rather than silently using JSON", async () => {
    const service = makeService(emittingTurn(0), () => "session-1")
    await expect(
      service.handle("trace/export", { format: "csv" } as never, context as never)
    ).rejects.toMatchObject({ structuredError: { code: "unsupported_capability" } })
    await service.close()
  })

  it("refuses a new trace subscription past the ceiling instead of growing without bound", async () => {
    const service = makeService(emittingTurn(0), () => "session-1")
    for (let index = 0; index < 64; index += 1) {
      await service.handle("trace/subscribe", {}, context as never)
    }
    await expect(service.handle("trace/subscribe", {}, context as never)).rejects.toMatchObject({
      structuredError: { code: "usage_error" },
    })
    await service.close()
  })

  it("refuses a turn that carries attachments instead of dropping them", async () => {
    const runTurn = emittingTurn(0)
    const service = makeService(runTurn, () => "session-1")
    await service.handle("session/create", {}, context as never)
    await expect(
      service.handle(
        "turn/run",
        {
          sessionId: "session-1",
          input: { prompt: "review this", attachments: [{ path: "/tmp/a.png" }] },
          commandId: "run-1",
        },
        context as never
      )
    ).rejects.toMatchObject({ structuredError: { code: "usage_error" } })
    expect(runTurn).not.toHaveBeenCalled()
    await service.close()
  })

  it("declares only versioned capabilities, and worker dispatch only when configured", async () => {
    const service = makeService(emittingTurn(0), () => "session-1")
    const unversioned = service.capabilities.filter(
      (capability) => !/^[a-z][a-z0-9-]*-v\d+$/.test(capability)
    )
    expect(unversioned).toEqual([])
    expect(service.capabilities).toContain("event-replay-v2")
    expect(service.capabilities).toContain("trace-unsubscribe-v1")
    expect(service.capabilities).toContain("session-forest-v1")
    expect(service.capabilities).toContain("callback-attribution-v1")
    // The old flat names are gone, and the misleading one in particular.
    expect(service.capabilities).not.toContain("sandbox-policy-snapshots")
    expect(service.capabilities).not.toContain("worker-dispatch-v1")
    await service.close()
  })

  it("attributes a client hook to the turn that fired it, not the first busy session", async () => {
    const fired: Array<Record<string, unknown>> = []
    context.requestClient.mockImplementation(async (_method: string, params: unknown) => {
      fired.push(params as Record<string, unknown>)
      return { ok: true, output: undefined }
    })

    let releaseSlow!: () => void
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve
    })

    const runTurn = jest.fn(async (params: UnifiedTurnParams): Promise<UnifiedTurnResult> => {
      const sessionId = params.sessionId ?? "session-1"
      const envelope = {
        schemaVersion: 1 as const,
        eventId: `${sessionId}:turn-1:attempt-1:0`,
        sequence: 0,
        sessionId,
        runId: `run-${sessionId}`,
        attemptId: `attempt-${sessionId}`,
        turnId: "turn-1",
        timestamp: new Date(0).toISOString(),
        hostRef: "test",
        runtime: "builtin",
        event: { kind: "lifecycle", phase: "started" },
      } satisfies AgentEventEnvelope
      params.onEnvelope?.(envelope)
      // The slow session stays inside its turn while the fast one fires a hook,
      // which is exactly the window the "first busy session" heuristic got wrong.
      if (sessionId === "session-slow") await slowGate
      const hooks = mockRegisteredHooks.get("rpc-client-hook:handler-1")
      await hooks?.PreToolUse?.({ toolName: "read_file" })
      return {
        result: {
          schemaVersion: 1 as const,
          type: "result" as const,
          status: "completed" as const,
          sessionId,
          runId: `run-${sessionId}`,
          turnId: "turn-1",
          attemptId: `attempt-${sessionId}`,
          text: "done",
          backend: "builtin",
          model: "test-model",
          capabilities: [],
          session: { persisted: true, turnCount: 1 },
        },
        envelopes: [envelope],
      }
    })

    let next = 0
    const ids = ["session-slow", "session-fast"]
    const service = makeService(
      runTurn as unknown as ReturnType<typeof emittingTurn>,
      () => ids[next++] ?? `session-${next}`
    )
    await service.handle("session/create", {}, context as never)
    await service.handle("session/create", {}, context as never)
    await service.handle(
      "hook/register",
      {
        handlerId: "handler-1",
        name: "pre-tool",
        event: "PreToolUse",
        timeoutPolicy: "continue",
      },
      context as never
    )

    const slow = service.handle(
      "turn/run",
      { sessionId: "session-slow", input: "slow", commandId: "run-slow" },
      context as never
    )
    // Let the slow turn get inside runTurn and mark itself busy first.
    await new Promise((resolve) => setTimeout(resolve, 5))
    await service.handle(
      "turn/run",
      { sessionId: "session-fast", input: "fast", commandId: "run-fast" },
      context as never
    )
    releaseSlow()
    await slow

    expect(fired).toHaveLength(2)
    const fast = fired.find((entry) => entry.sessionId === "session-fast")
    const slowFired = fired.find((entry) => entry.sessionId === "session-slow")
    expect(fast).toMatchObject({ runId: "run-session-fast", attemptId: "attempt-session-fast" })
    expect(slowFired).toMatchObject({
      runId: "run-session-slow",
      attemptId: "attempt-session-slow",
    })
    await service.close()
  })
  // ---- ADR-0142 Phase 3: host-persisted agent definitions --------------------

  const AGENT = { name: "Release bot", composition: { presetId: "coding" } }

  it("creates, reads, versions and archives agent definitions over RPC", async () => {
    const service = makeService(emittingTurn(0), () => "session-1")

    const created = (await service.handle(
      "agent/create",
      { definition: AGENT, agentId: "release-bot", commandId: "create-1" },
      context as never
    )) as { agentId: string; version: number; definitionDigest: string }
    expect(created).toMatchObject({ agentId: "release-bot", version: 1 })

    const updated = (await service.handle(
      "agent/update",
      {
        agentId: "release-bot",
        expectedVersion: 1,
        changes: { ...AGENT, name: "Release bot v2" },
        commandId: "update-1",
      },
      context as never
    )) as { version: number; name: string }
    expect(updated).toMatchObject({ version: 2, name: "Release bot v2" })

    expect(
      await service.handle("agent/versions", { agentId: "release-bot" }, context as never)
    ).toEqual({ agentId: "release-bot", versions: [1, 2] })

    expect(
      await service.handle("agent/get", { agentId: "release-bot", version: 1 }, context as never)
    ).toMatchObject({ version: 1, name: "Release bot" })

    expect(await service.handle("agent/list", {}, context as never)).toMatchObject({
      agents: [expect.objectContaining({ agentId: "release-bot", latestVersion: 2 })],
    })

    await service.handle("agent/archive", { agentId: "release-bot" }, context as never)
    expect(await service.handle("agent/list", {}, context as never)).toEqual({ agents: [] })
    // An archived version stays readable, because sessions reference it.
    expect(
      await service.handle("agent/get", { agentId: "release-bot", version: 1 }, context as never)
    ).toMatchObject({ version: 1, archivedAt: expect.any(String) })
    await service.close()
  })

  it("reports a stale compare-and-swap as version_conflict", async () => {
    const service = makeService(emittingTurn(0), () => "session-1")
    await service.handle("agent/create", { definition: AGENT, agentId: "cas" }, context as never)
    await service.handle(
      "agent/update",
      { agentId: "cas", expectedVersion: 1, changes: { ...AGENT, name: "Second" } },
      context as never
    )
    await expect(
      service.handle(
        "agent/update",
        { agentId: "cas", expectedVersion: 1, changes: { ...AGENT, name: "Third" } },
        context as never
      )
    ).rejects.toMatchObject({
      structuredError: {
        code: "version_conflict",
        detail: { expectedVersion: 1, actualVersion: 2 },
      },
    })
    await service.close()
  })

  it("replays durable command receipts for agent mutations across a restart", async () => {
    const first = makeService(emittingTurn(0), () => "session-1")
    const created = await first.handle(
      "agent/create",
      { definition: AGENT, agentId: "receipted", commandId: "create-agent-once" },
      context as never
    )
    await first.close()

    const restarted = makeService(emittingTurn(0), () => "session-1")
    await expect(
      restarted.handle(
        "agent/create",
        {
          definition: { ...AGENT, name: "Must not replace the receipt" },
          agentId: "different-agent",
          commandId: "create-agent-once",
        },
        context as never
      )
    ).resolves.toEqual(created)
    expect(await restarted.handle("agent/list", {}, context as never)).toMatchObject({
      agents: [expect.objectContaining({ agentId: "receipted" })],
    })

    const updated = await restarted.handle(
      "agent/update",
      {
        agentId: "receipted",
        expectedVersion: 1,
        changes: { ...AGENT, name: "Version 2" },
        commandId: "update-agent-once",
      },
      context as never
    )
    await expect(
      restarted.handle(
        "agent/update",
        {
          agentId: "receipted",
          expectedVersion: 2,
          changes: { ...AGENT, name: "Must not become version 3" },
          commandId: "update-agent-once",
        },
        context as never
      )
    ).resolves.toEqual(updated)
    expect(
      await restarted.handle("agent/versions", { agentId: "receipted" }, context as never)
    ).toEqual({ agentId: "receipted", versions: [1, 2] })
    await restarted.close()
  })

  it("freezes the resolved agent version into the session it creates", async () => {
    let next = 0
    const ids = ["session-a", "session-b"]
    const service = makeService(emittingTurn(0), () => ids[next++] ?? `session-${next}`)
    const v1 = (await service.handle(
      "agent/create",
      { definition: AGENT, agentId: "frozen" },
      context as never
    )) as { definitionDigest: string }

    const first = (await service.handle(
      "session/create",
      { agent: { agentId: "frozen" }, commandId: "create-a" },
      context as never
    )) as { sessionId: string; agentBinding: Record<string, unknown> }
    expect(first.agentBinding).toMatchObject({
      agentId: "frozen",
      version: 1,
      definitionDigest: v1.definitionDigest,
      compositionPresetId: "coding",
      compositionDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      executionFingerprint: expect.any(String),
    })

    const v2 = (await service.handle(
      "agent/update",
      { agentId: "frozen", expectedVersion: 1, changes: { ...AGENT, name: "Moved on" } },
      context as never
    )) as { definitionDigest: string }

    const second = (await service.handle(
      "session/create",
      { agent: { agentId: "frozen" }, commandId: "create-b" },
      context as never
    )) as { agentBinding: Record<string, unknown> }
    expect(second.agentBinding).toMatchObject({ version: 2, definitionDigest: v2.definitionDigest })

    // The older session did not follow the update.
    expect(
      await service.handle("session/state", { sessionId: "session-a" }, context as never)
    ).toMatchObject({ agentBinding: { version: 1, definitionDigest: v1.definitionDigest } })
    await service.close()
  })

  it("pins an explicit version rather than resolving latest", async () => {
    const service = makeService(emittingTurn(0), () => "session-1")
    await service.handle("agent/create", { definition: AGENT, agentId: "pinned" }, context as never)
    await service.handle(
      "agent/update",
      { agentId: "pinned", expectedVersion: 1, changes: { ...AGENT, name: "Newer" } },
      context as never
    )
    const created = (await service.handle(
      "session/create",
      { agent: { agentId: "pinned", version: 1 }, commandId: "create-pinned" },
      context as never
    )) as { agentBinding: Record<string, unknown> }
    expect(created.agentBinding).toMatchObject({ version: 1 })
    await service.close()
  })

  it("lowers appended instructions and composition selection into every turn", async () => {
    const runTurn = emittingTurn(0)
    const service = makeService(runTurn, () => "session-1")
    const outputSchema = { type: "object", properties: { summary: { type: "string" } } }
    await service.handle(
      "agent/create",
      {
        agentId: "lowered",
        definition: {
          ...AGENT,
          composition: { presetId: "coding", authority: "plan", autonomy: "suggest" },
          instructions: { append: "Always include verification evidence." },
          output: { schema: outputSchema, schemaDigest: contentDigest(outputSchema) },
        },
      },
      context as never
    )
    await service.handle(
      "session/create",
      { agent: { agentId: "lowered" }, commandId: "create-lowered" },
      context as never
    )
    await service.handle(
      "turn/run",
      { sessionId: "session-1", input: "ship", commandId: "run-lowered" },
      context as never
    )

    const lowered = runTurn.mock.calls[0]?.[0] as UnifiedTurnParams & {
      compositionSelection?: Record<string, unknown>
    }
    expect(lowered.config.systemPrompt).toBe("Always include verification evidence.")
    expect(lowered.compositionSelection).toEqual({
      presetId: "coding",
      authority: "plan",
      autonomy: "suggest",
    })
    expect(lowered.outputSchema).toEqual(outputSchema)
    await service.close()
  })

  it("keeps the frozen binding across a host restart", async () => {
    const first = makeService(emittingTurn(0), () => "session-1")
    await service_create_agent(first)
    await first.handle(
      "session/create",
      { agent: { agentId: "durable" }, commandId: "create-1" },
      context as never
    )
    await first.close()

    const restarted = makeService(emittingTurn(0), () => "session-1")
    expect(
      await restarted.handle("session/state", { sessionId: "session-1" }, context as never)
    ).toMatchObject({ agentBinding: { agentId: "durable", version: 1 } })
    await restarted.close()
  })

  async function service_create_agent(service: ReturnType<typeof makeService>) {
    await service.handle(
      "agent/create",
      { definition: AGENT, agentId: "durable" },
      context as never
    )
  }

  it("refuses to resolve latest on an archived agent but honours an explicit pin", async () => {
    let next = 0
    const ids = ["session-a", "session-b"]
    const service = makeService(emittingTurn(0), () => ids[next++] ?? `session-${next}`)
    await service.handle(
      "agent/create",
      { definition: AGENT, agentId: "shelved" },
      context as never
    )
    await service.handle("agent/archive", { agentId: "shelved" }, context as never)

    await expect(
      service.handle(
        "session/create",
        { agent: { agentId: "shelved" }, commandId: "create-a" },
        context as never
      )
    ).rejects.toMatchObject({ structuredError: { code: "agent_archived" } })

    const pinned = (await service.handle(
      "session/create",
      { agent: { agentId: "shelved", version: 1 }, commandId: "create-b" },
      context as never
    )) as { agentBinding: Record<string, unknown> }
    expect(pinned.agentBinding).toMatchObject({ version: 1 })
    await service.close()
  })

  it("reports an unknown agent instead of creating a session without one", async () => {
    const service = makeService(emittingTurn(0), () => "session-1")
    await expect(
      service.handle(
        "session/create",
        { agent: { agentId: "ghost" }, commandId: "create-1" },
        context as never
      )
    ).rejects.toMatchObject({ structuredError: { code: "agent_not_found" } })
    await service.close()
  })

  it("leaves sessions created without an agent unbound", async () => {
    const service = makeService(emittingTurn(0), () => "session-1")
    const created = (await service.handle("session/create", {}, context as never)) as Record<
      string,
      unknown
    >
    expect(created.agentBinding).toBeUndefined()
    await service.close()
  })

  it("refuses a definition that would store a credential", async () => {
    const service = makeService(emittingTurn(0), () => "session-1")
    await expect(
      service.handle(
        "agent/create",
        { definition: { ...AGENT, metadata: { apiKey: "sk-live" } }, agentId: "leaky" },
        context as never
      )
    ).rejects.toMatchObject({ structuredError: { code: "usage_error" } })
    await service.close()
  })

  it("declares the authoring capabilities it now implements", async () => {
    const service = makeService(emittingTurn(0), () => "session-1")
    expect(service.capabilities).toContain("agent-definitions-v1")
    expect(service.capabilities).toContain("agent-session-binding-v1")
    expect(service.methods).toEqual(expect.arrayContaining(["agent/create", "agent/update"]))
    await service.close()
  })
  it("refuses a turn whose agent declares a tool with no registered handler", async () => {
    const runTurn = emittingTurn(0)
    const service = makeService(runTurn, () => "session-1")
    const contract = {
      name: "read_file",
      description: "Read a file",
      inputSchema: { type: "object" },
      sideEffect: "none" as const,
    }
    await service.handle(
      "agent/create",
      {
        definition: {
          ...AGENT,
          toolRefs: [{ ...contract, schemaDigest: computeToolSchemaDigest(contract) }],
        },
        agentId: "tooled",
      },
      context as never
    )
    await service.handle(
      "session/create",
      { agent: { agentId: "tooled" }, commandId: "create-1" },
      context as never
    )

    await expect(
      service.handle(
        "turn/run",
        { sessionId: "session-1", input: "go", commandId: "run-1" },
        context as never
      )
    ).rejects.toMatchObject({ structuredError: { code: "handler_unavailable" } })
    expect(runTurn).not.toHaveBeenCalled()
    await service.close()
  })

  it("refuses a turn when the registered handler's schema digest has drifted", async () => {
    const runTurn = emittingTurn(0)
    const service = makeService(runTurn, () => "session-1")
    const contract = {
      name: "read_file",
      description: "Read a file",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      sideEffect: "none" as const,
    }
    await service.handle(
      "agent/create",
      {
        definition: {
          ...AGENT,
          toolRefs: [{ ...contract, schemaDigest: computeToolSchemaDigest(contract) }],
        },
        agentId: "drifted",
      },
      context as never
    )
    // Registered with a *different* input schema than the definition recorded.
    await service.handle(
      "tool/register",
      {
        handlerId: "handler-1",
        name: "read_file",
        description: "Read a file",
        inputSchema: { type: "object", properties: { file: { type: "string" } } },
        sideEffect: "none",
      },
      context as never
    )
    await service.handle(
      "session/create",
      { agent: { agentId: "drifted" }, commandId: "create-1" },
      context as never
    )

    await expect(
      service.handle(
        "turn/run",
        { sessionId: "session-1", input: "go", commandId: "run-1" },
        context as never
      )
    ).rejects.toMatchObject({ structuredError: { code: "schema_mismatch" } })
    expect(runTurn).not.toHaveBeenCalled()
    await service.close()
  })

  it("runs the turn once a matching handler is registered", async () => {
    const runTurn = emittingTurn(0)
    const service = makeService(runTurn, () => "session-1")
    const contract = {
      name: "read_file",
      description: "Read a file",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      sideEffect: "none" as const,
    }
    await service.handle(
      "agent/create",
      {
        definition: {
          ...AGENT,
          toolRefs: [{ ...contract, schemaDigest: computeToolSchemaDigest(contract) }],
        },
        agentId: "matched",
      },
      context as never
    )
    await service.handle("tool/register", { handlerId: "handler-1", ...contract }, context as never)
    await service.handle(
      "session/create",
      { agent: { agentId: "matched" }, commandId: "create-1" },
      context as never
    )
    await expect(
      service.handle(
        "turn/run",
        { sessionId: "session-1", input: "go", commandId: "run-1" },
        context as never
      )
    ).resolves.toMatchObject({ status: "completed" })
    expect(runTurn).toHaveBeenCalledTimes(1)
    await service.close()
  })

  it("leaves an unbound session's turns unaffected by the preflight", async () => {
    const runTurn = emittingTurn(0)
    const service = makeService(runTurn, () => "session-1")
    await service.handle("session/create", { commandId: "create-1" }, context as never)
    await expect(
      service.handle(
        "turn/run",
        { sessionId: "session-1", input: "go", commandId: "run-1" },
        context as never
      )
    ).resolves.toMatchObject({ status: "completed" })
    await service.close()
  })
  // ---- ADR-0142 Phase 4: content-addressed assets ---------------------------

  it("stores, stats and deletes assets over RPC", async () => {
    const service = makeService(emittingTurn(0), () => "session-1")
    const data = Buffer.from("hello asset").toString("base64")

    const put = (await service.handle(
      "asset/put",
      { data, mediaType: "text/plain", name: "note.txt", commandId: "put-1" },
      context as never
    )) as { assetId: string; digest: string; byteLength: number }
    expect(put).toMatchObject({ mediaType: "text/plain", byteLength: 11 })
    expect(put.digest).toMatch(/^sha256-[0-9a-f]{64}$/)

    expect(
      await service.handle("asset/stat", { assetId: put.assetId }, context as never)
    ).toMatchObject({ assetId: put.assetId, digest: put.digest })

    expect(
      await service.handle("asset/delete", { assetId: put.assetId }, context as never)
    ).toEqual({ ok: true })
    await expect(
      service.handle("asset/stat", { assetId: put.assetId }, context as never)
    ).rejects.toMatchObject({ structuredError: { code: "asset_not_found" } })
    await service.close()
  })

  it("declares asset storage but not asset carriage in a turn", async () => {
    const service = makeService(emittingTurn(0), () => "session-1")
    expect(service.capabilities).toContain("assets-v1")
    expect(service.capabilities).not.toContain("assets-in-turn-v1")
    await service.close()
  })

  it("refuses a turn carrying asset references rather than dropping them", async () => {
    const runTurn = emittingTurn(0)
    const service = makeService(runTurn, () => "session-1")
    await service.handle("session/create", { commandId: "create-1" }, context as never)
    await expect(
      service.handle(
        "turn/run",
        {
          sessionId: "session-1",
          input: {
            prompt: "look",
            assets: [
              { assetId: "asset-1", digest: "sha256-x", mediaType: "image/png", byteLength: 4 },
            ],
          },
          commandId: "run-1",
        },
        context as never
      )
    ).rejects.toMatchObject({ structuredError: { code: "unsupported_capability" } })
    expect(runTurn).not.toHaveBeenCalled()
    await service.close()
  })
  // ---- ADR-0142 Phase 4: keyless record and replay ---------------------------

  it("declares evals and refuses a fixture it cannot accept", async () => {
    const service = makeService(emittingTurn(0), () => "session-1")
    expect(service.capabilities).toContain("evals-v1")

    const rejected = (await service.handle(
      "eval/replay",
      { fixture: { nonsense: true } },
      context as never
    )) as { ok: boolean; errors?: string[]; summary: string }
    expect(rejected.ok).toBe(false)
    expect(rejected.summary).toContain("fixture rejected")
    expect(rejected.errors?.length).toBeGreaterThan(0)
    await service.close()
  })

  it("opens and closes a recording proxy, returning a non-committable fixture", async () => {
    const service = makeService(emittingTurn(0), () => "session-1")
    const scenario = { scenarioId: "s1", actors: [{ role: "root", actorRef: "actor-root" }] }

    const started = (await service.handle(
      "eval/record/start",
      { scenario, port: 0, commandId: "record-1" },
      context as never
    )) as { recordingId: string; proxyUrl: string }
    expect(started.proxyUrl).toMatch(/^http:\/\//)

    const stopped = (await service.handle(
      "eval/record/stop",
      { recordingId: started.recordingId, commandId: "record-stop-1" },
      context as never
    )) as { fixture: { tapes: unknown[]; scenario: unknown }; actors: string[] }
    expect(stopped.fixture.scenario).toEqual(scenario)
    expect(Array.isArray(stopped.fixture.tapes)).toBe(true)

    await expect(
      service.handle("eval/record/stop", { recordingId: started.recordingId }, context as never)
    ).rejects.toMatchObject({ structuredError: { code: "usage_error" } })
    await service.close()
  })

  it("closes an abandoned recording proxy when the service shuts down", async () => {
    const service = makeService(emittingTurn(0), () => "session-1")
    const started = (await service.handle(
      "eval/record/start",
      { scenario: { scenarioId: "s1", actors: [] }, port: 0 },
      context as never
    )) as { proxyUrl: string }
    const url = new URL(started.proxyUrl)
    // A listening socket would keep the process alive after the client left.
    await service.close()
    await expect(
      fetch(started.proxyUrl, { signal: AbortSignal.timeout(1_000) }).then(() => "reachable")
    ).rejects.toBeDefined()
    expect(url.port).not.toBe("0")
  })
})
