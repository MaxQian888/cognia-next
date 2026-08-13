import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import type { AgentEventEnvelope } from "@cognia/agent-config-types/agent-execution"
import { computeSequenceDigest } from "@cognia/agent-config-types/canonical-session"
import type { PluginToolExecRequest, PluginToolExecResponse } from "@/lib/claude/plugin-tool-ipc"
import type { PluginTool } from "@/types/plugin"
import {
  __resetSandboxPolicyBridgeForTesting,
  getActiveSandboxPolicy,
  setActiveSandboxPolicy,
} from "@/lib/sandbox/policy-bridge"
import type { UnifiedTurnParams, UnifiedTurnResult } from "../runtime/unified-runtime"

import { DEFAULT_RESOLVED_CONFIG } from "../../config/schema"
import { createAgentRuntimeService } from "./runtime-service"

const mockRegisteredPluginTools = new Map<string, PluginTool>()
const mockRegisterTool = jest.fn((_pluginId: string, tool: PluginTool) => {
  mockRegisteredPluginTools.set(tool.name, tool)
})
const mockUnregisterTool = jest.fn((toolName: string) => mockRegisteredPluginTools.delete(toolName))

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
      registerHooks: jest.fn(),
      unregisterHooks: jest.fn(),
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
  emit: jest.fn(async () => undefined),
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
  })

  afterEach(() => {
    __resetSandboxPolicyBridgeForTesting()
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
    const service = createAgentRuntimeService({
      config: { ...DEFAULT_RESOLVED_CONFIG, cwd: home, model: "test-model" },
      home,
      mintSessionId: () => "session-1",
    })
    await service.handle("session/create", {}, context as never)
    setActiveSandboxPolicy("session-1", {
      network: "off",
      writableRoots: [home],
      maxMemoryMb: 512,
    })
    const snapshot = await service.handle(
      "sandbox/snapshot",
      { sessionId: "session-1", commandId: "snapshot-one" },
      context as never
    )
    setActiveSandboxPolicy("session-1", { network: "on" })

    await service.handle(
      "sandbox/restore",
      {
        sessionId: "session-1",
        snapshotId: String(snapshot.snapshotId),
        commandId: "restore-one",
      },
      context as never
    )
    expect(getActiveSandboxPolicy("session-1")).toEqual({
      network: "off",
      writableRoots: [home],
      maxMemoryMb: 512,
    })
    expect(
      await service.handle("sandbox/status", { sessionId: "session-1" }, context as never)
    ).toMatchObject({ enabled: true, snapshotCount: 1 })
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

    expect(context.emit).toHaveBeenCalledWith(
      "trace/event",
      expect.objectContaining({
        subscriptionId: subscription.subscriptionId,
        span: expect.objectContaining({ method: "session/state", result: "ok" }),
      })
    )
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
})
