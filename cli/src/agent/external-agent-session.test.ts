/**
 * @jest-environment node
 */
import type {
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
import {
  acpPermissionRequestToCli,
  captureDecisionToAcp,
  createExternalAgentSession,
  externalAgentCredentialEnv,
  type ExternalAgentSessionManager,
} from "./external-agent-session"

function memoryTranscript(): { fs: TranscriptFs; lines: string[] } {
  const lines: string[] = []
  return {
    lines,
    fs: {
      append: (_path, line) => lines.push(line),
      read: () => null,
      mkdirp: () => undefined,
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
})

describe("createExternalAgentSession", () => {
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
    await new Promise((resolve) => setImmediate(resolve))
    expect(state.overlay).toMatchObject({
      kind: "permission",
      req: { toolName: "edit", input: { path: "a.ts" } },
    })
    gate.resolve({ decision: "allow" })
    dispatch({ type: "OVERLAY_CLOSE" })

    await expect(turn).resolves.toMatchObject({ ok: true })
    expect(state.cells.map((cell) => cell.kind)).toEqual(["user", "assistant"])
  })

  it("lazily materializes a preset, streams TUI actions, persists the turn, and reuses the ACP session", async () => {
    const { manager } = fakeManager()
    const transcript = memoryTranscript()
    const session = createExternalAgentSession({
      config: {
        ...DEFAULT_RESOLVED_CONFIG,
        cwd: "/work",
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
      expect.objectContaining({ workingDirectory: "/work", permissionMode: "default" })
    )
    expect(manager.execute).toHaveBeenNthCalledWith(
      1,
      "cli-external-cli-session",
      "first",
      expect.objectContaining({ context: { custom: { mcpServers: [] } } })
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
      config: { ...DEFAULT_RESOLVED_CONFIG, cwd: "/work", agentBackend: "claude-code" },
      manager,
      transcriptFs: memoryTranscript().fs,
    })
    const gate = jest.fn(async () => ({ decision: "allow_always" as const }))
    await session.send("go", { gate })
    const request: AcpPermissionRequest = {
      id: "p",
      toolCallId: "t",
      toolInfo: { id: "edit", name: "edit" },
      rawInput: { path: "a.ts" },
      options: [{ optionId: "always", name: "Always", kind: "allow_always" }],
    }

    await expect(getExecuteOptions()?.onPermissionRequest?.(request)).resolves.toMatchObject({
      requestId: "p",
      granted: true,
      rememberChoice: true,
      optionId: "always",
    })
    expect(gate).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "edit", input: { path: "a.ts" } })
    )
  })

  it("falls back to CaptureStreamEvent output for the readline chat", async () => {
    const { manager } = fakeManager()
    const session = createExternalAgentSession({
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

  it("cancels the live external session, switches mode, and removes the agent on close", async () => {
    const { manager } = fakeManager()
    const session = createExternalAgentSession({
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

  it("rejects builtin/unknown backends and unsuccessful external results", async () => {
    expect(() =>
      createExternalAgentSession({
        config: { ...DEFAULT_RESOLVED_CONFIG, cwd: "/work", agentBackend: "builtin" },
        manager: fakeManager().manager,
      })
    ).toThrow("requires an external backend")

    const { manager } = fakeManager({ success: false, error: "failed" })
    const session = createExternalAgentSession({
      config: { ...DEFAULT_RESOLVED_CONFIG, cwd: "/work", agentBackend: "claude-code" },
      manager,
      transcriptFs: memoryTranscript().fs,
    })
    await expect(session.send("go", { gate: async () => ({ decision: "allow" }) })).rejects.toThrow(
      "failed"
    )
  })
})
