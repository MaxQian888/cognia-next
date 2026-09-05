/**
 * @jest-environment node
 */
jest.mock("./configured-plugin-tool-handle", () => ({
  makeConfiguredCliPluginToolHandle: jest.fn(() => jest.fn(async () => ({ result: "ok" }))),
}))
jest.mock("@/lib/ai/agent/external/presets", () => {
  const actual = jest.requireActual("@/lib/ai/agent/external/presets")
  return {
    ...actual,
    resolvePreferredCodexExecutablePresetId: jest.fn(
      actual.resolvePreferredCodexExecutablePresetId
    ),
  }
})

import type {
  AcpConfigOption,
  AcpPermissionRequest,
  ExternalAgentConfig,
  ExternalAgentExecutionOptions,
  ExternalAgentResult,
} from "@/types/agent/external-agent"

import { DEFAULT_RESOLVED_CONFIG } from "../config/schema"
import { DEFAULT_PERMISSION_CHOICES } from "../tui/components/overlays/PermissionOverlay"
import { createGateController, runTurn } from "../tui/hooks/turn-engine"
import { createInitialState } from "../tui/state/initial"
import { tuiReducer } from "../tui/state/reducer"
import type { TranscriptFs } from "./transcript"
import { RunAndCaptureError } from "@/lib/claude/run-and-capture"
import * as externalPresets from "@/lib/ai/agent/external/presets"

import {
  acpPermissionRequestToCli,
  captureDecisionToAcp,
  bindExternalTurnSkillScope,
  classifyExternalFailure,
  createExternalAgentSession,
  externalAgentCredentialEnv,
  type ExternalAgentSessionManager,
} from "./external-agent-session"

function memoryTranscript(seed: Record<string, string> = {}): {
  fs: TranscriptFs
  lines: string[]
  written: Record<string, string>
} {
  const lines: string[] = []
  const written: Record<string, string> = { ...seed }
  return {
    lines,
    written,
    fs: {
      append: (_path, line) => lines.push(line),
      read: (p) => written[p] ?? null,
      mkdirp: () => undefined,
      write: (p, content) => {
        written[p] = content
      },
    },
  }
}

function fakeManager(result?: Partial<ExternalAgentResult>) {
  let executeOptions: ExternalAgentExecutionOptions | undefined
  const manager: ExternalAgentSessionManager = {
    addAgent: jest.fn(async () => undefined),
    execute: jest.fn(async (_agentId, _prompt, options) => {
      executeOptions = options
      options?.onEvent?.({
        type: "message_delta",
        timestamp: new Date(),
        delta: { type: "text", text: "hello" },
      })
      options?.onEvent?.({
        type: "done",
        timestamp: new Date(),
        success: true,
        tokenUsage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
      })
      return {
        success: true,
        sessionId: "acp-session-1",
        finalResponse: "hello",
        messages: [],
        steps: [],
        toolCalls: [],
        duration: 10,
        tokenUsage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
        ...result,
      }
    }),
    setSessionMode: jest.fn(async () => undefined),
    setSessionModel: jest.fn(async () => undefined),
    getConfigOptions: jest.fn(() => ({ status: "unsupported" as const })),
    setConfigOption: jest.fn(async () => [] as AcpConfigOption[]),
    getSessionModels: jest.fn(() => ({ status: "unsupported" as const })),
    cancel: jest.fn(async () => undefined),
    removeAgent: jest.fn(async () => undefined),
  }
  return { manager, getExecuteOptions: () => executeOptions }
}

describe("external-agent permission adaptation", () => {
  const request: AcpPermissionRequest = {
    id: "permission-1",
    requestId: "request-1",
    sessionId: "acp-session",
    toolCallId: "tool-1",
    title: "Run tests",
    toolInfo: { id: "bash", name: "bash", description: "Run a shell command" },
    rawInput: { command: "pnpm test" },
    locations: [{ path: "/work/package.json", line: 1 }],
    options: [
      { optionId: "once", name: "Allow once", kind: "allow_once" },
      { optionId: "always", name: "Always", kind: "allow_always" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ],
  }

  it("projects ACP requests into the existing CLI overlay contract", () => {
    expect(acpPermissionRequestToCli(request, "fallback-session")).toEqual({
      type: "permission_request",
      sessionId: "acp-session",
      requestId: "request-1",
      toolUseID: "tool-1",
      toolName: "bash",
      input: { command: "pnpm test" },
      title: "Run tests",
      displayName: "bash",
      description: "Run a shell command",
      blockedPath: "/work/package.json",
    })
  })

  it("falls back to the agent's reason when the tool carries no description", () => {
    // Pi's approval arrives with the extension's line in `reason` and nothing
    // in `toolInfo.description`, and `reason` reached no surface: the prompt
    // read "Allow bash?" with the command it was about to run nowhere on it.
    const withoutDescription: AcpPermissionRequest = {
      ...request,
      toolInfo: { id: "bash", name: "bash" },
      reason: "bash: echo hi",
    }
    expect(acpPermissionRequestToCli(withoutDescription, "fallback-session")).toMatchObject({
      description: "bash: echo hi",
      decisionReason: "bash: echo hi",
    })
  })

  it("prefers the tool's own description over the reason when both exist", () => {
    expect(
      acpPermissionRequestToCli({ ...request, reason: "why" }, "fallback-session")
    ).toMatchObject({ description: "Run a shell command", decisionReason: "why" })
  })

  it.each([
    ["allow", "once", false, "once"],
    ["allow_always", "always", true, "always"],
    ["deny", "reject", false, "once"],
  ] as const)("maps %s to the matching ACP option", (decision, optionId, rememberChoice, scope) => {
    expect(captureDecisionToAcp(request, { decision, message: "chosen" })).toEqual({
      requestId: "request-1",
      granted: decision !== "deny",
      reason: "chosen",
      rememberChoice,
      scope,
      optionId,
    })
  })

  it("falls back from allow always to a valid allow-once ACP option", () => {
    const onceOnly = {
      ...request,
      options: request.options?.filter((option) => option.kind !== "allow_always"),
    }
    expect(captureDecisionToAcp(onceOnly, { decision: "allow_always" })).toEqual({
      requestId: "request-1",
      granted: true,
      rememberChoice: false,
      scope: "once",
      optionId: "once",
    })
  })

  it("never escalates allow once to an allow-always-only ACP option", () => {
    const alwaysOnly = {
      ...request,
      options: request.options?.filter((option) => option.kind === "allow_always"),
    }
    expect(captureDecisionToAcp(alwaysOnly, { decision: "allow" })).toEqual({
      requestId: "request-1",
      granted: false,
      rememberChoice: false,
      scope: "once",
    })
  })
})

describe("createExternalAgentSession", () => {
  it("binds explicit and contextual Skills to the frozen turn and cleans once", () => {
    const register = jest.fn()
    const release = jest.fn()
    const cleanup = bindExternalTurnSkillScope(
      {
        sessionId: "s1",
        activeSkillIds: ["explicit"],
        contextualSkillIds: ["contextual"],
        turnId: "t1",
        attemptId: "a2",
      },
      { register: register as never, release }
    )
    expect(register).toHaveBeenCalledWith("s1", {
      allowedSkillIds: ["explicit", "contextual"],
      turnId: "t1",
      attemptId: "a2",
    })
    cleanup()
    cleanup()
    expect(release).toHaveBeenCalledTimes(1)
  })

  it("clears stale scope immediately when a turn has no Skills", () => {
    const register = jest.fn()
    const release = jest.fn()
    const cleanup = bindExternalTurnSkillScope(
      {
        sessionId: "s1",
        activeSkillIds: [],
        turnId: "t1",
        attemptId: "a1",
      },
      { register: register as never, release }
    )
    expect(register).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledWith("s1")
    cleanup()
    expect(release).toHaveBeenCalledTimes(1)
  })

  it("binds the external tool host to this session's resolved search config", async () => {
    const { makeConfiguredCliPluginToolHandle } = jest.requireMock(
      "./configured-plugin-tool-handle"
    ) as { makeConfiguredCliPluginToolHandle: jest.Mock }
    makeConfiguredCliPluginToolHandle.mockClear()
    const config = {
      ...DEFAULT_RESOLVED_CONFIG,
      cwd: "/work",
      agentBackend: "claude-code" as const,
      search: {
        defaultProvider: "brave" as const,
        providers: { brave: { apiKey: "search-key" } },
      },
    }
    const startToolHost = jest.fn(async () => ({
      endpoint: "http://127.0.0.1:1234",
      token: "token",
      isClosed: () => false,
      connections: () => 0,
      cancelInFlight: jest.fn(),
      close: jest.fn(async () => undefined),
    }))
    const session = createExternalAgentSession({
      config,
      manager: fakeManager().manager,
      transcriptFs: memoryTranscript().fs,
      startToolHost: startToolHost as never,
      buildToolHostServers: () => [],
    })

    await session.send("search", { gate: async () => ({ decision: "allow" }) })

    expect(makeConfiguredCliPluginToolHandle).toHaveBeenCalledWith(config)
    expect(startToolHost).toHaveBeenCalledTimes(1)
    await session.close()
  })

  it.each(["onEnvelope", "onAction", "onEvent"] as const)(
    "delivers hosted tool events to %s consumers",
    async (channel) => {
      const { manager } = fakeManager()
      let host: Parameters<
        NonNullable<import("./external-agent-session").ExternalAgentSessionParams["startToolHost"]>
      >[0]
      const execute = (manager.execute as jest.Mock).getMockImplementation()!
      ;(manager.execute as jest.Mock).mockImplementation(async (...args) => {
        host.onToolCall?.({ name: "read", input: { path: "a.ts" }, callKey: "host-1" })
        host.onToolResult?.({ name: "read", callKey: "host-1", ok: true, summary: "content" })
        return execute(...args)
      })
      const receive = jest.fn()
      const session = createExternalAgentSession({
        config: { ...DEFAULT_RESOLVED_CONFIG, cwd: "/work", agentBackend: "claude-code" },
        manager,
        transcriptFs: memoryTranscript().fs,
        startToolHost: async (params) => {
          host = params
          return {
            endpoint: "http://127.0.0.1:1234",
            token: "token",
            isClosed: () => false,
            connections: () => 0,
            cancelInFlight: jest.fn(),
            close: async () => undefined,
          } as never
        },
        buildToolHostServers: () => [],
      })
      try {
        await session.send("read", {
          gate: async () => ({ decision: "allow" }),
          [channel]: receive,
        })
        const events = receive.mock.calls.map(([value]) =>
          channel === "onEnvelope" ? value.event.kind : value.type
        )
        expect(events).toEqual(
          expect.arrayContaining(
            channel === "onAction" ? ["TOOL_CALL", "TOOL_RESULT"] : ["tool-call", "tool-result"]
          )
        )
        await expect(
          host!.gate?.({
            type: "permission_request",
            sessionId: "done",
            requestId: "late",
            toolUseID: "late",
            toolName: "bash",
            input: {},
          })
        ).resolves.toMatchObject({ decision: "deny", message: "No active turn" })
        receive.mockClear()
        host!.onToolCall?.({ name: "bash", input: {}, callKey: "late" })
        expect(receive).not.toHaveBeenCalled()
      } finally {
        await session.close()
      }
    }
  )

  it("preserves native diff refinements and diagnostics in envelope order", async () => {
    const { manager } = fakeManager()
    ;(manager.execute as jest.Mock).mockImplementation(async (_id, _prompt, options) => {
      for (const event of [
        {
          type: "tool_call_update",
          toolCallId: "edit-1",
          content: [{ type: "diff", path: "a.ts", oldText: "one", newText: "two" }],
        },
        { type: "error", error: "retrying", recoverable: true },
        { type: "hook_fire", event: "Stop", outcome: "context", warnings: [] },
        { type: "error", error: "failed", recoverable: false },
      ])
        options.onEvent({ ...event, timestamp: new Date() })
      return {
        success: false,
        error: "failed",
        messages: [],
        steps: [],
        toolCalls: [],
        duration: 1,
      }
    })
    const receive = jest.fn()
    const session = createExternalAgentSession({
      disableToolHost: true,
      config: { ...DEFAULT_RESOLVED_CONFIG, cwd: "/work", agentBackend: "claude-code" },
      manager,
      transcriptFs: memoryTranscript().fs,
    })
    try {
      await expect(
        session.send("edit", { gate: async () => ({ decision: "deny" }), onEnvelope: receive })
      ).rejects.toThrow("failed")
      expect(receive.mock.calls.map(([value]) => value.event)).toEqual([
        expect.objectContaining({
          kind: "tool-call",
          toolCallId: "edit-1",
          toolName: "Edit",
          input: { file_path: "a.ts", old_string: "one", new_string: "two" },
        }),
        expect.objectContaining({ kind: "warning", message: "retrying" }),
        expect.objectContaining({ kind: "informational", content: "Stop context" }),
        expect.objectContaining({ kind: "failure", message: "failed" }),
      ])
    } finally {
      await session.close()
    }
  })

  it("maps CLI credential-file providers onto each external CLI's native env contract", () => {
    const config = {
      ...DEFAULT_RESOLVED_CONFIG,
      cwd: "/work",
      providers: {
        codex: { authToken: "codex-subscription", apiKey: "sk-codex" },
        anthropic: { authToken: "claude-subscription", apiKey: "sk-anthropic" },
      },
    }

    expect(externalAgentCredentialEnv(config, "codex-app-server")).toEqual({
      CODEX_ACCESS_TOKEN: "codex-subscription",
      OPENAI_API_KEY: "sk-codex",
      CODEX_API_KEY: "sk-codex",
    })
    expect(externalAgentCredentialEnv(config, "claude-code")).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: "claude-subscription",
      ANTHROPIC_API_KEY: "sk-anthropic",
    })
  })

  it("integrates a stub permission ask with the existing overlay and completes the turn", async () => {
    const manager = fakeManager().manager
    manager.execute = jest.fn(async (_agentId, _prompt, options) => {
      const response = await options?.onPermissionRequest?.({
        id: "permission-1",
        toolCallId: "tool-1",
        title: "Edit a.ts",
        toolInfo: { id: "edit", name: "edit" },
        rawInput: { path: "a.ts" },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      })
      expect(response).toMatchObject({ granted: true, optionId: "allow" })
      options?.onEvent?.({
        type: "message_delta",
        timestamp: new Date(),
        delta: { type: "text", text: "done" },
      })
      options?.onEvent?.({ type: "done", timestamp: new Date(), success: true })
      return {
        success: true,
        sessionId: "acp-session",
        finalResponse: "done",
        messages: [],
        steps: [],
        toolCalls: [],
        duration: 1,
      }
    })
    const session = createExternalAgentSession({
      disableToolHost: true,
      config: { ...DEFAULT_RESOLVED_CONFIG, cwd: "/work", agentBackend: "claude-code" },
      manager,
      transcriptFs: memoryTranscript().fs,
    })
    let state = createInitialState(
      { ...DEFAULT_RESOLVED_CONFIG, cwd: "/work", agentBackend: "claude-code" },
      "cli-session"
    )
    const dispatch = (action: Parameters<typeof tuiReducer>[1]) => {
      state = tuiReducer(state, action)
    }
    const gate = createGateController((req) =>
      dispatch({
        type: "OVERLAY_OPEN",
        overlay: { kind: "permission", req, choices: DEFAULT_PERMISSION_CHOICES, index: 0 },
      })
    )

    const turn = runTurn({ session, prompt: "edit", dispatch, gate: gate.responder })
    // The turn now resolves the whole Cognia context before it reaches the
    // agent, so wait for the overlay rather than counting ticks.
    for (let i = 0; i < 200 && state.overlay.kind !== "permission"; i++) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    expect(state.overlay).toMatchObject({
      kind: "permission",
      req: { toolName: "edit", input: { path: "a.ts" } },
    })
    gate.resolve({ decision: "allow" })
    dispatch({ type: "OVERLAY_CLOSE" })

    await expect(turn).resolves.toMatchObject({ ok: true })
    expect(state.cells.map((cell) => cell.kind)).toEqual(["user", "assistant"])
  })

  it("blocks provider-visible PII before dispatching to an external agent", async () => {
    const { manager } = fakeManager()
    const session = createExternalAgentSession({
      disableToolHost: true,
      config: { ...DEFAULT_RESOLVED_CONFIG, cwd: "/work", agentBackend: "opencode-server" },
      manager,
      transcriptFs: memoryTranscript().fs,
    })

    await expect(
      session.send("Email alice@example.com with the report", {
        gate: async () => ({ decision: "allow" }),
      })
    ).rejects.toThrow("External agent input blocked by the outbound PII gate")
    expect(manager.execute).not.toHaveBeenCalled()
  })

  it("lazily materializes a preset, streams TUI actions, persists the turn, and reuses the ACP session", async () => {
    const { manager } = fakeManager()
    const transcript = memoryTranscript()
    const session = createExternalAgentSession({
      disableToolHost: true,
      config: {
        ...DEFAULT_RESOLVED_CONFIG,
        cwd: "/work",
        additionalRoots: ["/shared"],
        agentBackend: "claude-code",
      },
      sessionId: "cli-session",
      home: "/home/test",
      manager,
      transcriptFs: transcript.fs,
      now: () => 42,
    })
    const actions: string[] = []

    const first = await session.send("first", {
      gate: async () => ({ decision: "allow" }),
      onAction: (action) => actions.push(action.type),
    })
    await session.send("second", {
      gate: async () => ({ decision: "allow" }),
      onAction: (action) => actions.push(action.type),
    })

    expect(manager.addAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "cli-external-cli-session",
        enabled: true,
        process: expect.objectContaining({ cwd: "/work" }),
      }) as ExternalAgentConfig
    )
    expect(manager.execute).toHaveBeenNthCalledWith(
      1,
      "cli-external-cli-session",
      "first",
      expect.objectContaining({ workingDirectory: "/work", permissionMode: "acceptEdits" })
    )
    expect(manager.execute).toHaveBeenNthCalledWith(
      1,
      "cli-external-cli-session",
      "first",
      expect.objectContaining({
        context: { custom: { mcpServers: [], additionalDirectories: ["/shared"] } },
      })
    )
    expect(manager.execute).toHaveBeenNthCalledWith(
      2,
      "cli-external-cli-session",
      "second",
      expect.objectContaining({ sessionId: "acp-session-1" })
    )
    expect(actions).toEqual(["INFLIGHT_TEXT", "SET_USAGE", "INFLIGHT_TEXT", "SET_USAGE"])
    expect(first).toMatchObject({
      text: "hello",
      sessionId: "cli-session",
      usage: { inputTokens: 3, outputTokens: 2 },
    })
    expect(transcript.lines.map((line) => JSON.parse(line).role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ])
  })

  it("feeds ACP permission requests through the existing gate", async () => {
    const { manager, getExecuteOptions } = fakeManager()
    const session = createExternalAgentSession({
      disableToolHost: true,
      config: { ...DEFAULT_RESOLVED_CONFIG, cwd: "/work", agentBackend: "claude-code" },
      manager,
      transcriptFs: memoryTranscript().fs,
    })
    const gate = jest.fn(async () => ({ decision: "allow_always" as const }))
    const request: AcpPermissionRequest = {
      id: "p",
      toolCallId: "t",
      toolInfo: { id: "edit", name: "edit" },
      rawInput: { path: "a.ts" },
      options: [{ optionId: "always", name: "Always", kind: "allow_always" }],
    }

    const execute = (manager.execute as jest.Mock).getMockImplementation()!
    ;(manager.execute as jest.Mock).mockImplementation(async (...args) => {
      const result = await execute(...args)
      await expect(getExecuteOptions()?.onPermissionRequest?.(request)).resolves.toMatchObject({
        requestId: "p",
        granted: true,
        rememberChoice: true,
        optionId: "always",
      })
      return result
    })
    await session.send("go", { gate })
    expect(gate).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "edit", input: { path: "a.ts" } })
    )
    gate.mockClear()
    await expect(getExecuteOptions()?.onPermissionRequest?.(request)).resolves.toMatchObject({
      granted: false,
      reason: "No active turn",
    })
    expect(gate).not.toHaveBeenCalled()
  })

  it("rejects an approval that resolves after cancellation and ignores late events", async () => {
    const { manager } = fakeManager()
    const controller = new AbortController()
    const onAction = jest.fn()
    ;(manager.execute as jest.Mock).mockImplementation(async (_id, _prompt, options) => {
      const response = await options.onPermissionRequest({
        id: "cancelled-request",
        toolInfo: { id: "bash", name: "bash" },
        options: [{ optionId: "once", name: "Allow once", kind: "allow_once" }],
      })
      expect(response.granted).toBe(false)
      options.onEvent({
        type: "message_delta",
        timestamp: new Date(),
        delta: { type: "text", text: "late" },
      })
      return {
        success: false,
        error: "Cancelled",
        messages: [],
        steps: [],
        toolCalls: [],
        duration: 1,
      }
    })
    const session = createExternalAgentSession({
      disableToolHost: true,
      config: { ...DEFAULT_RESOLVED_CONFIG, cwd: "/work", agentBackend: "claude-code" },
      manager,
      transcriptFs: memoryTranscript().fs,
    })
    try {
      await expect(
        session.send("go", {
          signal: controller.signal,
          onAction,
          gate: async () => {
            controller.abort()
            return { decision: "allow" }
          },
        })
      ).rejects.toThrow("Cancelled")
      expect(onAction).not.toHaveBeenCalled()
    } finally {
      await session.close()
    }
  })

  it("falls back to CaptureStreamEvent output for the readline chat", async () => {
    const { manager } = fakeManager()
    const session = createExternalAgentSession({
      disableToolHost: true,
      config: { ...DEFAULT_RESOLVED_CONFIG, cwd: "/work", agentBackend: "claude-code" },
      manager,
      transcriptFs: memoryTranscript().fs,
    })
    const events: string[] = []
    await session.send("go", {
      gate: async () => ({ decision: "allow" }),
      onEvent: (event) => events.push(event.type),
    })
    expect(events).toEqual(["text-delta", "usage"])
  })

  it("prefers canonical envelopes over both legacy external callbacks", async () => {
    const { manager } = fakeManager()
    const session = createExternalAgentSession({
      disableToolHost: true,
      config: { ...DEFAULT_RESOLVED_CONFIG, cwd: "/work", agentBackend: "claude-code" },
      manager,
      transcriptFs: memoryTranscript().fs,
      now: () => 42,
    })
    const kinds: string[] = []
    const onEvent = jest.fn()
    const onAction = jest.fn()
    await session.send("go", {
      gate: async () => ({ decision: "allow" }),
      onEnvelope: (envelope) => kinds.push(envelope.event.kind),
      onEvent,
      onAction,
    })
    expect(kinds).toEqual(["text-delta", "usage"])
    expect(onEvent).not.toHaveBeenCalled()
    expect(onAction).not.toHaveBeenCalled()
  })

  it("cancels the live external session, switches mode, and removes the agent on close", async () => {
    const { manager } = fakeManager()
    const session = createExternalAgentSession({
      disableToolHost: true,
      config: { ...DEFAULT_RESOLVED_CONFIG, cwd: "/work", agentBackend: "claude-code" },
      sessionId: "cli-session",
      manager,
      transcriptFs: memoryTranscript().fs,
    })
    await session.send("go", { gate: async () => ({ decision: "allow" }) })
    await session.setPermissionMode?.("plan")
    await session.close()
    await session.close()

    expect(manager.setSessionMode).toHaveBeenCalledWith(
      "cli-external-cli-session",
      "acp-session-1",
      "plan"
    )
    expect(manager.cancel).toHaveBeenCalledWith("cli-external-cli-session", "acp-session-1")
    expect(manager.removeAgent).toHaveBeenCalledTimes(1)
  })

  describe("setModel", () => {
    const newSession = (manager: ReturnType<typeof fakeManager>["manager"]) =>
      createExternalAgentSession({
        disableToolHost: true,
        config: { ...DEFAULT_RESOLVED_CONFIG, cwd: "/work", agentBackend: "claude-code" },
        sessionId: "cli-session",
        manager,
        transcriptFs: memoryTranscript().fs,
      })

    it("switches the LIVE session in place so the thread survives a /model pick", async () => {
      const { manager } = fakeManager()
      const session = newSession(manager)
      await session.send("go", { gate: async () => ({ decision: "allow" }) })

      await expect(session.setModel?.("gpt-5.6-sol")).resolves.toBe(true)
      expect(manager.setSessionModel).toHaveBeenCalledWith(
        "cli-external-cli-session",
        "acp-session-1",
        "gpt-5.6-sol"
      )
      await session.send("continue", { gate: async () => ({ decision: "allow" }) })
      expect(manager.execute).toHaveBeenLastCalledWith(
        expect.any(String),
        expect.any(String),
        expect.objectContaining({ model: "gpt-5.6-sol" })
      )
    })

    it("uses ACP model config options for listing and live switching", async () => {
      const { manager } = fakeManager()
      ;(manager.getConfigOptions as jest.Mock).mockReturnValue({
        status: "ok",
        data: [
          {
            id: "model",
            name: "Model",
            category: "model_config",
            type: "select",
            currentValue: "claude-sonnet-4-5",
            options: [
              { value: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
              { value: "claude-opus-4-1", name: "Claude Opus 4.1" },
            ],
          },
        ],
      })
      const session = newSession(manager)
      await session.send("go", { gate: async () => ({ decision: "allow" }) })

      await expect(session.listModels?.()).resolves.toEqual([
        { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
        { id: "claude-opus-4-1", name: "Claude Opus 4.1" },
      ])
      await expect(session.setModel?.("claude-opus-4-1")).resolves.toBe(true)
      expect(manager.setConfigOption).toHaveBeenCalledWith(
        "cli-external-cli-session",
        "acp-session-1",
        "model",
        "claude-opus-4-1"
      )
      expect(manager.setSessionModel).not.toHaveBeenCalled()
      await session.send("continue", { gate: async () => ({ decision: "allow" }) })
      expect(manager.execute).toHaveBeenLastCalledWith(
        expect.any(String),
        expect.any(String),
        expect.objectContaining({ model: "claude-opus-4-1" })
      )
    })

    it("creates and retains the real ACP session when models are opened before the first turn", async () => {
      const { manager } = fakeManager()
      const createSession = jest.fn(async () => ({ id: "acp-model-probe" }))
      const closeSession = jest.fn(async () => undefined)
      manager.createSession = createSession
      manager.closeSession = closeSession
      ;(manager.getConfigOptions as jest.Mock).mockReturnValue({
        status: "ok",
        data: [
          {
            id: "model",
            name: "Model",
            category: "model_config",
            type: "select",
            currentValue: "claude-sonnet-4-5",
            options: [{ value: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" }],
          },
        ],
      })
      const session = newSession(manager)

      await expect(session.listModels?.()).resolves.toEqual([
        { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
      ])
      expect(createSession).toHaveBeenCalledWith(
        "cli-external-cli-session",
        expect.objectContaining({ cwd: "/work" })
      )
      await session.send("go", { gate: async () => ({ decision: "allow" }) })
      expect(manager.execute).toHaveBeenCalledWith(
        "cli-external-cli-session",
        expect.any(String),
        expect.objectContaining({ sessionId: "acp-model-probe" })
      )
      expect(closeSession).not.toHaveBeenCalledWith("cli-external-cli-session", "acp-model-probe")
    })

    it("prefers model_config over a legacy model category", async () => {
      const { manager } = fakeManager()
      ;(manager.getConfigOptions as jest.Mock).mockReturnValue({
        status: "ok",
        data: [
          {
            id: "legacy-model",
            name: "Legacy",
            category: "model",
            type: "select",
            currentValue: "legacy",
            options: [{ value: "legacy", name: "Legacy" }],
          },
          {
            id: "stable-model",
            name: "Model",
            category: "model_config",
            type: "select",
            currentValue: "stable",
            options: [{ value: "stable", name: "Stable" }],
          },
        ],
      })
      const session = newSession(manager)
      await session.send("go", { gate: async () => ({ decision: "allow" }) })

      await expect(session.listModels?.()).resolves.toEqual([{ id: "stable", name: "Stable" }])
      await expect(session.setModel?.("stable")).resolves.toBe(true)
      expect(manager.setConfigOption).toHaveBeenCalledWith(
        "cli-external-cli-session",
        "acp-session-1",
        "stable-model",
        "stable"
      )
      expect(manager.setSessionModel).not.toHaveBeenCalled()
    })

    it("reports no live switch before the first turn (nothing to switch yet)", async () => {
      const { manager } = fakeManager()
      // The model still applies on the next turn — `execute` reads config each
      // time — so the caller treats false as "deferred", not as a failure.
      await expect(newSession(manager).setModel?.("gpt-5.6-sol")).resolves.toBe(false)
      expect(manager.setSessionModel).not.toHaveBeenCalled()
    })

    it("never throws when the agent rejects the model", async () => {
      const { manager } = fakeManager()
      ;(manager.setSessionModel as jest.Mock).mockRejectedValueOnce(new Error("unknown model"))
      const session = newSession(manager)
      await session.send("go", { gate: async () => ({ decision: "allow" }) })
      // A rejected model must not take the turn — or the TUI — down.
      await expect(session.setModel?.("nope")).resolves.toBe(false)
      await session.send("continue", { gate: async () => ({ decision: "allow" }) })
      expect(manager.execute).toHaveBeenLastCalledWith(
        expect.any(String),
        expect.any(String),
        expect.not.objectContaining({ model: "nope" })
      )
    })
  })

  it("rejects builtin/unknown backends and unsuccessful external results", async () => {
    expect(() =>
      createExternalAgentSession({
        disableToolHost: true,
        config: { ...DEFAULT_RESOLVED_CONFIG, cwd: "/work", agentBackend: "builtin" },
        manager: fakeManager().manager,
      })
    ).toThrow("requires an external backend")

    const { manager } = fakeManager({ success: false, error: "failed" })
    const session = createExternalAgentSession({
      disableToolHost: true,
      config: { ...DEFAULT_RESOLVED_CONFIG, cwd: "/work", agentBackend: "claude-code" },
      manager,
      transcriptFs: memoryTranscript().fs,
    })
    await expect(session.send("go", { gate: async () => ({ decision: "allow" }) })).rejects.toThrow(
      "failed"
    )
  })
})

describe("external-agent adaptation edge cases", () => {
  it("falls back to the request id and an empty input, and carries a decision reason", () => {
    expect(
      acpPermissionRequestToCli(
        {
          id: "req-only",
          sessionId: "acp",
          toolInfo: { id: "bash", name: "bash" },
          reason: "policy",
        },
        "fallback"
      )
    ).toMatchObject({
      requestId: "req-only",
      toolUseID: "req-only",
      input: {},
      decisionReason: "policy",
    })
  })

  it.each(["codex", "codex-acp", "codex-app-server"])(
    "maps %s credentials through the openai fallback",
    (presetId) => {
      expect(
        externalAgentCredentialEnv(
          {
            ...DEFAULT_RESOLVED_CONFIG,
            cwd: "/work",
            providers: { openai: { apiKey: "sk-o", authToken: "tok" } },
          },
          presetId
        )
      ).toEqual({ CODEX_ACCESS_TOKEN: "tok", OPENAI_API_KEY: "sk-o", CODEX_API_KEY: "sk-o" })
    }
  )

  it("forwards an Anthropic base URL and yields nothing for an unmapped preset", () => {
    const config = {
      ...DEFAULT_RESOLVED_CONFIG,
      cwd: "/work",
      providers: { anthropic: { baseURL: "https://relay.example" } },
    }
    expect(externalAgentCredentialEnv(config, "claude-code")).toEqual({
      ANTHROPIC_BASE_URL: "https://relay.example",
    })
    expect(externalAgentCredentialEnv(config, "opencode")).toEqual({})
  })
})

describe("classifyExternalFailure", () => {
  it("defaults to a recoverable session error so one bad turn never discards the conversation", () => {
    expect(classifyExternalFailure("model refused the request")).toBe("session_error")
    expect(classifyExternalFailure("429 rate limited")).toBe("session_error")
    expect(classifyExternalFailure("")).toBe("session_error")
  })

  it.each([
    "spawn codex ENOENT",
    "write EPIPE",
    "agent process exited unexpectedly",
    "adapter is not connected",
    "connection closed by peer",
  ])("treats %p as a dead process", (message) => {
    expect(classifyExternalFailure(message)).toBe("sidecar_exited")
  })

  it("honours an explicit error code over the message text", () => {
    expect(classifyExternalFailure("something odd", "disconnected")).toBe("sidecar_exited")
  })
})

describe("external-agent turn bounds", () => {
  const baseConfig = { ...DEFAULT_RESOLVED_CONFIG, cwd: "/work", agentBackend: "claude-code" }

  /** A manager whose turn emits one event and then never finishes. */
  function hangingManager(opts: { onPermission?: boolean } = {}) {
    const manager: ExternalAgentSessionManager = {
      addAgent: jest.fn(async () => undefined),
      execute: jest.fn(async (_agentId, _prompt, options) => {
        options?.onEvent?.({
          type: "message_delta",
          sessionId: "acp-hang",
          timestamp: new Date(),
          delta: { type: "text", text: "thinking" },
        })
        if (opts.onPermission) {
          await options?.onPermissionRequest?.({
            id: "p1",
            requestId: "p1",
            sessionId: "acp-hang",
            toolCallId: "t1",
            toolInfo: { id: "bash", name: "bash" },
            rawInput: {},
            options: [{ optionId: "once", name: "Allow once", kind: "allow_once" }],
          })
          return {
            success: true,
            sessionId: "acp-hang",
            finalResponse: "done",
            messages: [],
            steps: [],
            toolCalls: [],
            duration: 1,
          }
        }
        return new Promise<ExternalAgentResult>(() => {})
      }),
      setSessionMode: jest.fn(async () => undefined),
      setSessionModel: jest.fn(async () => undefined),
      cancel: jest.fn(async () => undefined),
      removeAgent: jest.fn(async () => undefined),
    }
    return manager
  }

  it("hands the manager an explicit, effectively unbounded per-turn wall clock", async () => {
    const { manager, getExecuteOptions } = fakeManager()
    const session = createExternalAgentSession({
      disableToolHost: true,
      config: baseConfig,
      manager,
      transcriptFs: memoryTranscript().fs,
    })

    await session.send("go", { gate: async () => ({ decision: "allow" }) })

    // Anything near the 60s connect budget would kill ordinary agentic turns.
    expect(getExecuteOptions()?.timeout).toBeGreaterThan(60 * 60 * 1000)
  })

  it("still honours an explicit caller timeout", async () => {
    const { manager, getExecuteOptions } = fakeManager()
    const session = createExternalAgentSession({
      disableToolHost: true,
      config: baseConfig,
      manager,
      transcriptFs: memoryTranscript().fs,
    })

    await session.send("go", { gate: async () => ({ decision: "allow" }), timeoutMs: 5_000 })

    expect(getExecuteOptions()?.timeout).toBe(5_000)
  })

  it("does not make startup stricter when the stream watchdog is disabled", async () => {
    const { manager } = fakeManager()
    const session = createExternalAgentSession({
      disableToolHost: true,
      config: { ...baseConfig, streamIdleTimeoutMs: 0 },
      manager,
      transcriptFs: memoryTranscript().fs,
    })

    await session.send("go", { gate: async () => ({ decision: "allow" }) })

    // Regression: `streamIdleTimeoutMs || undefined` used to fall through to the
    // preset's 30s default, so DISABLING the watchdog tightened the budget.
    expect(manager.addAgent).toHaveBeenCalledWith(
      expect.objectContaining({ timeout: 60_000 }) as ExternalAgentConfig
    )
  })

  it("fails a silent turn as recoverable and cancels without discarding the session", async () => {
    const manager = hangingManager()
    const session = createExternalAgentSession({
      disableToolHost: true,
      config: { ...baseConfig, streamIdleTimeoutMs: 20 },
      manager,
      transcriptFs: memoryTranscript().fs,
    })

    const error = await session
      .send("go", { gate: async () => ({ decision: "allow" }) })
      .catch((err: unknown) => err)

    expect(error).toBeInstanceOf(RunAndCaptureError)
    expect((error as RunAndCaptureError).code).toBe("session_error")
    expect(manager.cancel).toHaveBeenCalledWith(expect.any(String), "acp-hang")
    expect(manager.removeAgent).not.toHaveBeenCalled()
  })

  it("classifies a thrown execution failure instead of letting it read as a dead session", async () => {
    const manager: ExternalAgentSessionManager = {
      addAgent: jest.fn(async () => undefined),
      execute: jest.fn(async () => {
        throw new Error("provider returned 500")
      }),
      setSessionMode: jest.fn(async () => undefined),
      setSessionModel: jest.fn(async () => undefined),
      cancel: jest.fn(async () => undefined),
      removeAgent: jest.fn(async () => undefined),
    }
    const session = createExternalAgentSession({
      disableToolHost: true,
      config: baseConfig,
      manager,
      transcriptFs: memoryTranscript().fs,
    })

    const error = await session
      .send("go", { gate: async () => ({ decision: "allow" }) })
      .catch((err: unknown) => err)

    expect((error as RunAndCaptureError).code).toBe("session_error")
  })

  it("passes an already-classified error through untouched", async () => {
    const cause = new RunAndCaptureError("agent process exited", "sidecar_exited")
    const manager: ExternalAgentSessionManager = {
      addAgent: jest.fn(async () => undefined),
      execute: jest.fn(async () => {
        throw cause
      }),
      setSessionMode: jest.fn(async () => undefined),
      setSessionModel: jest.fn(async () => undefined),
      cancel: jest.fn(async () => undefined),
      removeAgent: jest.fn(async () => undefined),
    }
    const session = createExternalAgentSession({
      disableToolHost: true,
      config: baseConfig,
      manager,
      transcriptFs: memoryTranscript().fs,
    })

    await expect(session.send("go", { gate: async () => ({ decision: "allow" }) })).rejects.toBe(
      cause
    )
  })

  it("treats a dead process as unrecoverable so the caller respawns", async () => {
    const { manager } = fakeManager({
      success: false,
      error: "spawn codex ENOENT",
      errorCode: "spawn_failed",
    })
    const session = createExternalAgentSession({
      disableToolHost: true,
      config: baseConfig,
      manager,
      transcriptFs: memoryTranscript().fs,
    })

    const error = await session
      .send("go", { gate: async () => ({ decision: "allow" }) })
      .catch((err: unknown) => err)

    expect((error as RunAndCaptureError).code).toBe("sidecar_exited")
  })

  it("falls back to a default idle budget when none is configured", async () => {
    const { manager } = fakeManager()
    const config = { ...baseConfig }
    delete (config as { streamIdleTimeoutMs?: number }).streamIdleTimeoutMs
    const session = createExternalAgentSession({
      disableToolHost: true,
      config,
      manager,
      transcriptFs: memoryTranscript().fs,
    })

    await expect(
      session.send("go", { gate: async () => ({ decision: "allow" }) })
    ).resolves.toMatchObject({ text: "hello" })
    expect(manager.addAgent).toHaveBeenCalledWith(
      expect.objectContaining({ timeout: 60_000 }) as ExternalAgentConfig
    )
  })

  it("publishes the resolved tool-host projection to the capability owner", async () => {
    const { manager } = fakeManager()
    const onToolHostStatus = jest.fn()
    const session = createExternalAgentSession({
      disableToolHost: true,
      config: baseConfig,
      manager,
      transcriptFs: memoryTranscript().fs,
      onToolHostStatus,
    })

    await session.send("go", { gate: async () => ({ decision: "allow" }) })

    expect(onToolHostStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: baseConfig.agentBackend,
        attachable: false,
        running: false,
      })
    )
  })

  it("projects tool and usage actions into CaptureStreamEvents for the readline chat", async () => {
    const manager: ExternalAgentSessionManager = {
      addAgent: jest.fn(async () => undefined),
      execute: jest.fn(async (_agentId, _prompt, options) => {
        options?.onEvent?.({
          type: "tool_use_start",
          sessionId: "s",
          timestamp: new Date(),
          toolUseId: "t1",
          toolName: "Read",
          kind: "read",
          rawInput: { file_path: "/a.ts" },
        })
        options?.onEvent?.({
          type: "tool_result",
          sessionId: "s",
          timestamp: new Date(),
          toolUseId: "t1",
          toolName: "Read",
          kind: "read",
          rawInput: { file_path: "/a.ts" },
          result: "contents",
          isError: true,
        })
        options?.onEvent?.({
          type: "done",
          sessionId: "s",
          timestamp: new Date(),
          success: true,
          tokenUsage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
        })
        return {
          success: true,
          sessionId: "s",
          finalResponse: "ok",
          messages: [],
          steps: [],
          toolCalls: [],
          duration: 1,
        }
      }),
      setSessionMode: jest.fn(async () => undefined),
      setSessionModel: jest.fn(async () => undefined),
      cancel: jest.fn(async () => undefined),
      removeAgent: jest.fn(async () => undefined),
    }
    const session = createExternalAgentSession({
      disableToolHost: true,
      config: baseConfig,
      manager,
      transcriptFs: memoryTranscript().fs,
    })
    const events: string[] = []

    // No `onAction` — the readline chat only understands CaptureStreamEvents.
    await session.send("go", {
      gate: async () => ({ decision: "allow" }),
      onEvent: (event) => events.push(event.type),
    })

    expect(events).toEqual(["tool-call", "tool-result", "usage"])
  })

  it("forwards every configured execution field the backend can honour", async () => {
    const { manager, getExecuteOptions } = fakeManager()
    const controller = new AbortController()
    const session = createExternalAgentSession({
      disableToolHost: true,
      config: {
        ...baseConfig,
        model: "stale-built-in-model",
        agentBackends: { "claude-code": { model: "claude-opus-4-1" } },
        systemPrompt: "be terse",
        allowedTools: ["Read", "Bash"],
        additionalRoots: ["/shared"],
      },
      manager,
      transcriptFs: memoryTranscript().fs,
    })

    await session.send("go", {
      gate: async () => ({ decision: "allow" }),
      signal: controller.signal,
    })

    expect(getExecuteOptions()).toMatchObject({
      model: "claude-opus-4-1",
      systemPrompt: "be terse",
      allowedTools: ["Read", "Bash"],
      signal: controller.signal,
      context: { custom: { mcpServers: [], additionalDirectories: ["/shared"] } },
    })
  })

  it("reuses an agent the backend controller already connected", async () => {
    const { manager } = fakeManager()
    const session = createExternalAgentSession({
      disableToolHost: true,
      config: baseConfig,
      manager,
      transcriptFs: memoryTranscript().fs,
      connection: { agentId: "preconnected-1", presetId: "claude-code" },
    })

    // Live before any turn: the process is already up.
    expect(session.isLive?.()).toBe(true)
    await session.send("go", { gate: async () => ({ decision: "allow" }) })

    // No second process — the startup connect is the only spawn.
    expect(manager.addAgent).not.toHaveBeenCalled()
    expect(manager.execute).toHaveBeenCalledWith("preconnected-1", "go", expect.any(Object))

    // Ownership stays with the controller that registered it.
    await session.close()
    expect(manager.removeAgent).not.toHaveBeenCalled()
    expect(manager.cancel).toHaveBeenCalledWith("preconnected-1", "acp-session-1")
  })

  it("forwards the user's MCP servers into session/new", async () => {
    const { manager, getExecuteOptions } = fakeManager()
    const session = createExternalAgentSession({
      disableToolHost: true,
      config: baseConfig,
      manager,
      transcriptFs: memoryTranscript().fs,
      resolveMcpServers: () =>
        [
          {
            id: "files",
            name: "files",
            transport: "stdio",
            enabled: true,
            config: { command: "node", args: ["server.js"] },
          },
        ] as never,
    })

    await session.send("go", { gate: async () => ({ decision: "allow" }) })

    // Was a hardcoded `[]`, so a server enabled in `/mcp` did nothing here while
    // the panel still showed it as on.
    expect(getExecuteOptions()?.context?.custom).toMatchObject({
      mcpServers: [{ name: "files", command: "node", args: ["server.js"] }],
    })
  })

  it("re-resolves MCP servers after an invalidate, without respawning the agent", async () => {
    let servers: unknown[] = []
    const { manager, getExecuteOptions } = fakeManager()
    const session = createExternalAgentSession({
      disableToolHost: true,
      config: baseConfig,
      manager,
      transcriptFs: memoryTranscript().fs,
      resolveMcpServers: () => servers as never,
    })

    await session.send("first", { gate: async () => ({ decision: "allow" }) })
    expect(getExecuteOptions()?.context?.custom).toMatchObject({ mcpServers: [] })

    // `/mcp enable files`
    servers = [
      { id: "f", name: "files", transport: "stdio", enabled: true, config: { command: "node" } },
    ]
    await session.send("second", { gate: async () => ({ decision: "allow" }) })
    // Still cached — a resolved set must not change under a running turn.
    expect(getExecuteOptions()?.context?.custom).toMatchObject({ mcpServers: [] })

    session.invalidateOptions?.()
    await session.send("third", { gate: async () => ({ decision: "allow" }) })

    expect(getExecuteOptions()?.context?.custom).toMatchObject({
      mcpServers: [{ name: "files", command: "node", args: [] }],
    })
    expect(manager.addAgent).toHaveBeenCalledTimes(1)
  })

  it("records the agent's own session id so a later resume can continue it", async () => {
    const transcript = memoryTranscript()
    const { manager } = fakeManager()
    const session = createExternalAgentSession({
      disableToolHost: true,
      config: baseConfig,
      sessionId: "cli-1",
      home: "/home/.cognia",
      manager,
      transcriptFs: transcript.fs,
    })

    await session.send("go", { gate: async () => ({ decision: "allow" }) })

    const link = JSON.parse(
      transcript.written["/home/.cognia/sessions/cli-1.external.json"]!
    ) as Record<string, unknown>
    expect(link).toMatchObject({ backend: "claude-code", externalSessionId: "acp-session-1" })
    // The context version rides along so a later resume can refuse a session
    // created under settings that have since changed.
    expect(typeof link.contextVersion).toBe("string")
  })

  it("resumes the recorded agent session instead of starting an empty one", async () => {
    // Resolve the version this config produces, then seed a link carrying it —
    // resume is only safe when the recorded context still matches.
    const probe = memoryTranscript()
    const probeManager = fakeManager()
    const probeSession = createExternalAgentSession({
      disableToolHost: true,
      config: baseConfig,
      sessionId: "cli-1",
      home: "/home/.cognia",
      manager: probeManager.manager,
      transcriptFs: probe.fs,
    })
    await probeSession.send("first", { gate: async () => ({ decision: "allow" }) })
    const recorded = probe.written["/home/.cognia/sessions/cli-1.external.json"]!

    const transcript = memoryTranscript({
      "/home/.cognia/sessions/cli-1.external.json": JSON.stringify({
        ...(JSON.parse(recorded) as Record<string, unknown>),
        externalSessionId: "acp-earlier",
      }),
    })
    const { manager, getExecuteOptions } = fakeManager()
    const session = createExternalAgentSession({
      disableToolHost: true,
      config: baseConfig,
      sessionId: "cli-1",
      home: "/home/.cognia",
      manager,
      transcriptFs: transcript.fs,
    })

    await session.send("continue", { gate: async () => ({ decision: "allow" }) })

    // Without this the transcript came back but the agent remembered nothing.
    expect(getExecuteOptions()?.sessionId).toBe("acp-earlier")
  })

  it("refuses to resume a link recorded before context versions existed", async () => {
    // Silently continuing it would hand the agent a conversation whose settings
    // Cognia can no longer vouch for.
    const transcript = memoryTranscript({
      "/home/.cognia/sessions/cli-1.external.json": JSON.stringify({
        backend: "claude-code",
        externalSessionId: "acp-earlier",
      }),
    })
    const { manager, getExecuteOptions } = fakeManager()
    const session = createExternalAgentSession({
      disableToolHost: true,
      config: baseConfig,
      sessionId: "cli-1",
      home: "/home/.cognia",
      manager,
      transcriptFs: transcript.fs,
    })

    await session.send("continue", { gate: async () => ({ decision: "allow" }) })

    expect(getExecuteOptions()?.sessionId).toBeUndefined()
  })

  it("ignores a link recorded on a different backend", async () => {
    const transcript = memoryTranscript({
      "/home/.cognia/sessions/cli-1.external.json": JSON.stringify({
        backend: "codex",
        externalSessionId: "codex-9",
      }),
    })
    const { manager, getExecuteOptions } = fakeManager()
    const session = createExternalAgentSession({
      disableToolHost: true,
      config: baseConfig,
      sessionId: "cli-1",
      home: "/home/.cognia",
      manager,
      transcriptFs: transcript.fs,
    })

    await session.send("go", { gate: async () => ({ decision: "allow" }) })

    // No agent can load another agent's session; asking would fail confusingly.
    expect(getExecuteOptions()?.sessionId).toBeUndefined()
  })

  it("names the backend it does not recognise", () => {
    expect(() =>
      createExternalAgentSession({
        disableToolHost: true,
        config: { ...baseConfig, agentBackend: "cdoex" },
        manager: fakeManager().manager,
      })
    ).toThrow("Unknown external-agent backend: cdoex")
  })

  it("reports cache token usage and normalizes the auto permission mode", async () => {
    const { manager, getExecuteOptions } = fakeManager({
      tokenUsage: {
        promptTokens: 3,
        completionTokens: 2,
        totalTokens: 5,
        cacheReadTokens: 7,
        cacheWriteTokens: 9,
        reasoningTokens: 1,
        contextTokens: 120_000,
        modelContextWindow: 272_000,
      },
    })
    const session = createExternalAgentSession({
      disableToolHost: true,
      config: { ...baseConfig, permissionMode: "auto" },
      manager,
      transcriptFs: memoryTranscript().fs,
    })

    const turn = await session.send("go", { gate: async () => ({ decision: "allow" }) })

    expect(turn.usage).toMatchObject({
      cacheReadInputTokens: 7,
      cacheCreationInputTokens: 9,
      reasoningTokens: 1,
      contextTokens: 120_000,
      contextWindow: 272_000,
    })
    // "auto" is a CLI-side alias the ACP contract does not know about.
    expect(getExecuteOptions()?.permissionMode).toBe("default")
  })

  it("tracks liveness and tolerates a close before any turn", async () => {
    const { manager } = fakeManager()
    const session = createExternalAgentSession({
      disableToolHost: true,
      config: baseConfig,
      manager,
      transcriptFs: memoryTranscript().fs,
    })

    expect(session.isLive?.()).toBe(false)
    await session.close()
    expect(manager.removeAgent).not.toHaveBeenCalled()

    await expect(session.send("go", { gate: async () => ({ decision: "allow" }) })).rejects.toThrow(
      "agent session is closed"
    )
  })

  it("still removes the agent when cancelling a live session fails", async () => {
    const { manager } = fakeManager()
    ;(manager.cancel as jest.Mock).mockRejectedValueOnce(new Error("already gone"))
    const session = createExternalAgentSession({
      disableToolHost: true,
      config: baseConfig,
      manager,
      transcriptFs: memoryTranscript().fs,
    })

    await session.send("go", { gate: async () => ({ decision: "allow" }) })
    expect(session.isLive?.()).toBe(true)
    await session.close()

    expect(manager.removeAgent).toHaveBeenCalledTimes(1)
  })

  it("describes a failure that carried no message, and a non-Error throw", async () => {
    const { manager: silent } = fakeManager({ success: false, error: undefined })
    const quiet = createExternalAgentSession({
      disableToolHost: true,
      config: baseConfig,
      manager: silent,
      transcriptFs: memoryTranscript().fs,
    })
    await expect(quiet.send("go", { gate: async () => ({ decision: "allow" }) })).rejects.toThrow(
      "External agent execution failed"
    )

    const manager: ExternalAgentSessionManager = {
      addAgent: jest.fn(async () => undefined),
      execute: jest.fn(async () => {
        throw "just a string"
      }),
      setSessionMode: jest.fn(async () => undefined),
      setSessionModel: jest.fn(async () => undefined),
      cancel: jest.fn(async () => undefined),
      removeAgent: jest.fn(async () => undefined),
    }
    const session = createExternalAgentSession({
      disableToolHost: true,
      config: baseConfig,
      manager,
      transcriptFs: memoryTranscript().fs,
    })
    await expect(session.send("go", { gate: async () => ({ decision: "allow" }) })).rejects.toThrow(
      "just a string"
    )
  })

  it("resolves the preferred codex executable preset lazily", async () => {
    const { manager } = fakeManager()
    const session = createExternalAgentSession({
      disableToolHost: true,
      config: { ...baseConfig, agentBackend: "codex" },
      manager,
      transcriptFs: memoryTranscript().fs,
    })

    await session.send("go", { gate: async () => ({ decision: "allow" }) })

    expect(manager.addAgent).toHaveBeenCalledWith(
      expect.objectContaining({ process: expect.objectContaining({ cwd: "/work" }) })
    )
  })

  it("forwards options and the saved model of the resolved native Codex engine", async () => {
    const preferred = jest
      .spyOn(externalPresets, "resolvePreferredCodexExecutablePresetId")
      .mockResolvedValue("codex-app-server")
    const { manager, getExecuteOptions } = fakeManager()
    const session = createExternalAgentSession({
      disableToolHost: true,
      config: {
        ...baseConfig,
        agentBackend: "codex",
        thinkingLevel: "high",
        skillDirs: ["/work/skills"],
        externalSkills: true,
        agentBackends: {
          codex: { model: "fallback" },
          "codex-app-server": { model: "native-model" },
        },
      },
      manager,
      transcriptFs: memoryTranscript().fs,
    })
    try {
      await session.send("go", { gate: async () => ({ decision: "allow" }) })
      expect(manager.addAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          protocol: "codex-app-server",
          codexOptions: { defaultReasoningEffort: "high", extraSkillRoots: ["/work/skills"] },
        })
      )
      expect(getExecuteOptions()?.model).toBe("native-model")
    } finally {
      await session.close()
      preferred.mockRestore()
    }
  })

  it("builds its own manager when none is injected", () => {
    expect(() =>
      createExternalAgentSession({
        disableToolHost: true,
        config: baseConfig,
        transcriptFs: memoryTranscript().fs,
      })
    ).not.toThrow()
  })

  it("pauses the watchdog while a permission prompt awaits the user", async () => {
    const manager = hangingManager({ onPermission: true })
    const session = createExternalAgentSession({
      disableToolHost: true,
      config: { ...baseConfig, streamIdleTimeoutMs: 30 },
      manager,
      transcriptFs: memoryTranscript().fs,
    })

    const result = await session.send("go", {
      // Deliberate far past the idle budget — an approval must never trip it.
      gate: async () => {
        await new Promise((resolve) => setTimeout(resolve, 150))
        return { decision: "allow" as const }
      },
    })

    expect(result.text).toBe("done")
    expect(manager.cancel).not.toHaveBeenCalled()
  })

  it("pauses the watchdog for broker approvals as well as native approvals", async () => {
    let brokerGate: import("./permission-gate").PermissionResponder | undefined
    const { manager } = fakeManager()
    ;(manager.execute as jest.Mock).mockImplementation(async (_id, _prompt, options) => {
      options.onEvent({
        type: "message_delta",
        sessionId: "external-1",
        timestamp: new Date(),
        delta: { type: "text", text: "Waiting for the tool" },
      })
      await brokerGate!({
        type: "permission_request",
        sessionId: "external-1",
        requestId: "broker-1",
        toolUseID: "tool-1",
        toolName: "bash",
        input: { command: "echo approved" },
      })
      return {
        success: true,
        sessionId: "external-1",
        finalResponse: "done",
        messages: [],
        steps: [],
        toolCalls: [],
        duration: 1,
      }
    })
    const session = createExternalAgentSession({
      config: { ...baseConfig, streamIdleTimeoutMs: 30 },
      manager,
      transcriptFs: memoryTranscript().fs,
      startToolHost: async ({ gate }) => {
        brokerGate = gate
        return {
          endpoint: "http://127.0.0.1:1234",
          token: "token",
          isClosed: () => false,
          connections: () => 0,
          cancelInFlight: jest.fn(),
          close: async () => undefined,
        } as never
      },
      buildToolHostServers: () => [],
    })
    try {
      await expect(
        session.send("go", {
          gate: async () => {
            await new Promise((resolve) => setTimeout(resolve, 150))
            return { decision: "allow" }
          },
        })
      ).resolves.toMatchObject({ text: "done" })
      expect(manager.cancel).not.toHaveBeenCalled()
    } finally {
      await session.close()
    }
  })
})
