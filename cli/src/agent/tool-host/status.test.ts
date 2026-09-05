/**
 * @jest-environment node
 */
import {
  __resetToolHostStatusForTesting,
  clearToolHostStatus,
  latestToolHostStatus,
  publishToolHostStatus,
  publishBuiltinToolHostStatus,
  observeBuiltinToolResult,
  readToolHostStatus,
  type ToolHostSnapshot,
} from "./status"
import type { ResolvedCliSessionContext } from "../session-context"
import { DEFAULT_BUILTIN_TOOLS } from "@cognia/agent-config-types"

const snapshot = (overrides: Partial<ToolHostSnapshot> = {}): ToolHostSnapshot => ({
  backend: "codex",
  contextVersion: "v1",
  attachable: true,
  running: true,
  builtinToolCount: 4,
  hostToolCount: 1,
  subagentDispatch: false,
  userMcpCount: 0,
  connections: 1,
  ...overrides,
})

afterEach(() => __resetToolHostStatusForTesting())

describe("tool-host status registry", () => {
  const builtinSession = {
    sessionId: "builtin-session",
    contextVersion: "ctx",
    cwd: "/project",
    sendOptions: {
      builtinTools: { coreFiles: true, lsp: true, codeGraph: false },
      lsp: { enabled: true, servers: [] },
      permissionMode: "acceptEdits",
      pluginTools: [{ name: "ask_user" }, { name: "dispatch_agent" }],
    },
    mcpServers: [],
    activeSkillIds: [],
    contextualSkills: [],
  } as unknown as ResolvedCliSessionContext

  it("reports lazy dependencies as initializing rather than ready merely because enabled", () => {
    const result = publishBuiltinToolHostStatus(builtinSession, "ready")
    expect(result.builtin?.categories.lsp).toMatchObject({ state: "initializing" })
    expect(result.builtin?.categories.codeGraph).toMatchObject({ state: "disabled" })
    expect(result.builtin?.categories.coreFiles).toMatchObject({ state: "ready" })
    expect(result.hostToolCount).toBe(2)
    expect(result.subagentDispatch).toBe(true)
  })

  it("records dependency failure and recovery from actual tool results", () => {
    publishBuiltinToolHostStatus(builtinSession, "ready")
    observeBuiltinToolResult("builtin-session", {
      kind: "tool-result",
      toolName: "mcp__cognia-tools__lsp_hover",
      isError: true,
      result: "LSP host unavailable",
    })
    expect(readToolHostStatus("builtin-session")?.builtin?.categories.lsp).toMatchObject({
      state: "failed",
      reason: "LSP host unavailable",
    })
    observeBuiltinToolResult("builtin-session", {
      kind: "tool-result",
      toolName: "lsp_hover",
      result: "symbol",
    })
    expect(readToolHostStatus("builtin-session")?.builtin?.categories.lsp).toEqual({
      state: "ready",
    })
  })
  it("publishes native terminal dependency and spawn failures with their recovery reason", () => {
    const session = {
      ...builtinSession,
      sendOptions: {
        ...builtinSession.sendOptions,
        builtinTools: { ...DEFAULT_BUILTIN_TOOLS, terminalRepl: true },
      },
    }
    for (const reason of [
      "node-pty is not available on this host. Reinstall node-pty.",
      "PTY helper is not executable. Restore its executable permission.",
      "node-pty spawn failed: posix_spawnp failed.",
    ]) {
      publishBuiltinToolHostStatus(session, "ready")
      observeBuiltinToolResult(session.sessionId, {
        kind: "tool-result",
        toolName: "terminal_repl_spawn",
        isError: true,
        result: reason,
      })
      expect(readToolHostStatus(session.sessionId)?.builtin?.categories.terminalRepl).toEqual({
        state: "failed",
        reason,
      })
    }
  })
  it("does not promote cached diagnostics to language-server readiness", () => {
    publishBuiltinToolHostStatus(builtinSession, "ready")
    expect(
      observeBuiltinToolResult(builtinSession.sessionId, {
        kind: "tool-result",
        toolName: "lsp_diagnostics",
        result: [],
      })
    ).toBeUndefined()
    expect(readToolHostStatus(builtinSession.sessionId)?.builtin?.categories.lsp.state).toBe(
      "initializing"
    )
    observeBuiltinToolResult(builtinSession.sessionId, {
      kind: "tool-result",
      toolName: "lsp_hover",
      isError: true,
      result: "LSP host unavailable",
    })
    observeBuiltinToolResult(builtinSession.sessionId, {
      kind: "tool-result",
      toolName: "lsp_diagnostics",
      result: [],
    })
    expect(readToolHostStatus(builtinSession.sessionId)?.builtin?.categories.lsp.state).toBe(
      "failed"
    )
  })

  it.each(["initializing", "failed"] as const)(
    "ignores late tool results while the host is %s",
    (phase) => {
      const before = publishBuiltinToolHostStatus(builtinSession, phase, "Host is not running")
      expect(
        observeBuiltinToolResult(builtinSession.sessionId, {
          kind: "tool-result",
          toolName: "lsp_hover",
          result: "late success",
        })
      ).toBeUndefined()
      expect(readToolHostStatus(builtinSession.sessionId)).toEqual(before)
    }
  )

  it("publishes startup failure without claiming a running relay or tools", () => {
    const result = publishBuiltinToolHostStatus(builtinSession, "failed", "relay unavailable")
    expect(result.running).toBe(false)
    expect(result.hostToolCount).toBe(0)
    expect(result.builtin).toMatchObject({ phase: "failed", reason: "relay unavailable" })
  })
  it("keeps policy-disabled tools disabled even when a stale result arrives", () => {
    const session = {
      ...builtinSession,
      sendOptions: { ...builtinSession.sendOptions, toolSurface: "none" as const },
    }
    const result = publishBuiltinToolHostStatus(session, "ready")
    expect(result.builtin?.categories.lsp).toEqual({
      state: "disabled",
      reason: "Excluded by the effective tool policy",
    })
    expect(
      observeBuiltinToolResult(session.sessionId, {
        kind: "tool-result",
        toolName: "lsp_hover",
        result: "late",
      })
    ).toBeUndefined()
  })

  it("does not equate an unresolved LSP configuration with a usable server", () => {
    const result = publishBuiltinToolHostStatus(
      { ...builtinSession, sendOptions: { ...builtinSession.sendOptions, lsp: undefined } },
      "ready"
    )
    expect(result.builtin?.categories.lsp).toEqual({
      state: "failed",
      reason: "LSP configuration was not resolved",
    })
  })

  it("retains lazy service evidence within a context and resets it for a new context", () => {
    publishBuiltinToolHostStatus(builtinSession, "ready")
    observeBuiltinToolResult(builtinSession.sessionId, {
      kind: "tool-result",
      toolName: "lsp_hover",
      result: "symbol",
    })
    expect(
      publishBuiltinToolHostStatus(builtinSession, "ready").builtin?.categories.lsp.state
    ).toBe("ready")
    expect(
      publishBuiltinToolHostStatus({ ...builtinSession, contextVersion: "changed" }, "ready")
        .builtin?.categories.lsp.state
    ).toBe("initializing")
  })

  it("reports initialization, configured skills, and the resolved execution capabilities", () => {
    const result = publishBuiltinToolHostStatus(
      {
        ...builtinSession,
        activeSkillIds: ["skill"],
        sendOptions: {
          ...builtinSession.sendOptions,
          builtinProcessSandbox: {
            launcher: "/bin/launcher",
            writableRoots: [],
            readableRoots: [],
            network: false,
          },
          execution: {
            runtimeAdapter: "ai-sdk",
            capabilities: { effective: ["streaming"] },
          } as never,
        },
      },
      "initializing"
    )
    expect(result.builtin).toMatchObject({
      skills: true,
      runtime: "ai-sdk",
      capabilities: ["streaming"],
      categories: {
        sandbox: { state: "initializing" },
        coreFiles: { state: "initializing", reason: "Waiting for the tool host" },
      },
    })
    expect(
      publishBuiltinToolHostStatus({ ...builtinSession, contextualSkills: [{} as never] }, "ready")
        .builtin?.skills
    ).toBe(true)
  })

  it("ignores non-tool events, foreign tools, and ordinary execution failures", () => {
    expect(
      observeBuiltinToolResult("missing", { kind: "tool-result", toolName: "read", result: "x" })
    ).toBeUndefined()
    publishBuiltinToolHostStatus(builtinSession, "ready")
    expect(
      observeBuiltinToolResult(builtinSession.sessionId, { kind: "text-delta", delta: "x" })
    ).toBeUndefined()
    expect(
      observeBuiltinToolResult(builtinSession.sessionId, {
        kind: "tool-result",
        toolName: "mcp__other__lsp_hover",
        result: "x",
      })
    ).toBeUndefined()
    expect(
      observeBuiltinToolResult(builtinSession.sessionId, {
        kind: "tool-result",
        toolName: "lsp_hover",
        isError: true,
        result: "Syntax error in user file",
      })
    ).toBeUndefined()
    expect(
      observeBuiltinToolResult(builtinSession.sessionId, {
        kind: "tool-result",
        toolName: "lsp_hover",
        isError: true,
        result: { error: "binary not installed" },
      })?.builtin?.categories.lsp
    ).toMatchObject({ state: "failed", reason: '{"error":"binary not installed"}' })
  })
  it("exposes a missing sandbox helper as a repairable failure", () => {
    const result = publishBuiltinToolHostStatus(
      {
        ...builtinSession,
        sendOptions: {
          ...builtinSession.sendOptions,
          builtinTools: {
            ...DEFAULT_BUILTIN_TOOLS,
            ...builtinSession.sendOptions.builtinTools,
            process: true,
          },
          builtinProcessSandbox: {
            launcher: "",
            writableRoots: ["/project"],
            readableRoots: [],
            network: false,
            unavailableReason: "Reinstall the sandbox launcher",
          },
        },
      },
      "ready"
    )
    expect(result.builtin?.categories.sandbox).toEqual({
      state: "failed",
      reason: "Reinstall the sandbox launcher",
    })
    expect(result.builtin?.categories.process).toEqual({
      state: "failed",
      reason: "Reinstall the sandbox launcher",
    })
  })
  it("returns undefined for a session that published nothing", () => {
    expect(readToolHostStatus("unknown")).toBeUndefined()
  })

  it("round-trips a published snapshot", () => {
    publishToolHostStatus("s1", snapshot())
    expect(readToolHostStatus("s1")).toMatchObject({ backend: "codex", contextVersion: "v1" })
  })

  it("replaces the previous snapshot rather than accumulating", () => {
    publishToolHostStatus("s1", snapshot())
    publishToolHostStatus("s1", snapshot({ contextVersion: "v2", running: false }))
    expect(readToolHostStatus("s1")).toMatchObject({ contextVersion: "v2", running: false })
  })

  it("keeps sessions independent", () => {
    publishToolHostStatus("s1", snapshot({ backend: "codex" }))
    publishToolHostStatus("s2", snapshot({ backend: "claude-code" }))
    expect(readToolHostStatus("s1")?.backend).toBe("codex")
    expect(readToolHostStatus("s2")?.backend).toBe("claude-code")
  })

  it("forgets a session on clear, so a stale panel cannot report a dead bridge", () => {
    publishToolHostStatus("s1", snapshot())
    clearToolHostStatus("s1")
    expect(readToolHostStatus("s1")).toBeUndefined()
  })

  it("exposes the most recent snapshot for surfaces with no session id", () => {
    expect(latestToolHostStatus()).toBeUndefined()
    publishToolHostStatus("s1", snapshot({ backend: "codex" }))
    publishToolHostStatus("s2", snapshot({ backend: "claude-code" }))
    expect(latestToolHostStatus()?.backend).toBe("claude-code")
  })
})
