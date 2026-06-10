/**
 * @jest-environment node
 */
import {
  createAgentSession,
  withCliAutoApprovedTools,
  CLI_AUTO_APPROVED_TOOLS,
} from "./session-runner"
import type { SendOptions } from "@/lib/claude/types"
import { createPermissionGate } from "./permission-gate"
import { readTranscript, type TranscriptFs } from "./transcript"
import { DEFAULT_RESOLVED_CONFIG, type ResolvedConfig } from "../config/schema"
import { DEFAULT_BUILTIN_TOOLS } from "@/lib/claude/types"
import type { SidecarBootstrap } from "../runtime/bootstrap"
import type { RunAndCaptureResult } from "@/lib/claude/run-and-capture"

const HOME = "/home/u/.cognia"

function cfg(): ResolvedConfig {
  return {
    ...DEFAULT_RESOLVED_CONFIG,
    builtinTools: { ...DEFAULT_BUILTIN_TOOLS },
    providers: { anthropic: { apiKey: "sk" } },
    cwd: "/work",
    model: "claude-x",
  }
}

function memFs() {
  const files = new Map<string, string>()
  const fsx: TranscriptFs = {
    append: (p, line) => files.set(p, (files.get(p) ?? "") + line),
    read: (p) => (files.has(p) ? files.get(p)! : null),
    mkdirp: () => undefined,
  }
  return { fsx, files }
}

function result(text: string): RunAndCaptureResult {
  return { text, messageId: "m", a2uiSurfaces: {}, a2uiSurfaceOrder: [] }
}

describe("withCliAutoApprovedTools", () => {
  it("auto-approves the full read-only surface but never mutating/side-effecting tools", () => {
    const out = withCliAutoApprovedTools({} as SendOptions)
    for (const t of CLI_AUTO_APPROVED_TOOLS) {
      expect(out.suppressApprovalForTools).toContain(t)
    }
    // Derived from the risk model, so it spans every category's read-only tools,
    // not just the core four.
    for (const t of [
      "mcp__cognia-tools__ls",
      "mcp__cognia-tools__read",
      "mcp__cognia-tools__grep",
      "mcp__cognia-tools__glob",
      "mcp__cognia-tools__git_status",
      "mcp__cognia-tools__git_diff",
      "mcp__cognia-tools__lsp_hover",
      "mcp__cognia-tools__list_processes",
      "mcp__cognia-tools__file_info",
      "mcp__cognia-tools__TodoWrite",
      "mcp__cognia-tools__terminal_repl_read",
    ]) {
      expect(out.suppressApprovalForTools).toContain(t)
    }
    // Mutating / side-effecting tools (requiresApproval: true) must NOT be here.
    for (const t of [
      "mcp__cognia-tools__write",
      "mcp__cognia-tools__edit",
      "mcp__cognia-tools__multi_edit",
      "mcp__cognia-tools__bash",
      "mcp__cognia-tools__file_move",
      "mcp__cognia-tools__directory_delete",
      "mcp__cognia-tools__start_process",
      "mcp__cognia-tools__shell_execute_advanced",
      "mcp__cognia-tools__terminal_repl_spawn",
    ]) {
      expect(out.suppressApprovalForTools).not.toContain(t)
    }
  })

  it("preserves and de-dupes any pre-existing suppressions", () => {
    const out = withCliAutoApprovedTools({
      suppressApprovalForTools: ["custom_tool", "mcp__cognia-tools__ls"],
    } as SendOptions)
    expect(out.suppressApprovalForTools).toContain("custom_tool")
    expect(out.suppressApprovalForTools!.filter((t) => t === "mcp__cognia-tools__ls")).toHaveLength(
      1
    )
  })

  it("merges the user's persisted 'Allow always' tools (incl. risky ones)", () => {
    const out = withCliAutoApprovedTools({} as SendOptions, ["mcp__cognia-tools__bash"])
    // The read-only set is still there...
    expect(out.suppressApprovalForTools).toContain("mcp__cognia-tools__ls")
    // ...plus the explicitly-trusted risky tool the user always-allowed.
    expect(out.suppressApprovalForTools).toContain("mcp__cognia-tools__bash")
  })
})

describe("createAgentSession", () => {
  it("auto-approves read-only tools in the options handed to capture", async () => {
    const capture = jest.fn().mockResolvedValue(result("ok"))
    const session = createAgentSession({
      config: cfg(),
      sessionId: "s_allow",
      home: HOME,
      now: () => 1000,
      bootstrap: jest
        .fn()
        .mockResolvedValue({ transport: {}, shutdown: jest.fn() } as unknown as SidecarBootstrap),
      resolveOptions: async () => ({ model: "m", provider: "anthropic" }) as never,
      capture,
      transcriptFs: memFs().fsx,
    })
    await session.send("hi", { gate: createPermissionGate({ yes: true }) })
    const sendOptions = capture.mock.calls[0][2] as SendOptions
    expect(sendOptions.suppressApprovalForTools).toContain("mcp__cognia-tools__ls")
  })

  it("threads the persisted always-allow store into the resolved options", async () => {
    const capture = jest.fn().mockResolvedValue(result("ok"))
    const session = createAgentSession({
      config: cfg(),
      sessionId: "s_allow2",
      home: HOME,
      now: () => 1000,
      bootstrap: jest
        .fn()
        .mockResolvedValue({ transport: {}, shutdown: jest.fn() } as unknown as SidecarBootstrap),
      resolveOptions: async () => ({ model: "m", provider: "anthropic" }) as never,
      resolveApprovedTools: () => new Set(["mcp__cognia-tools__bash"]),
      capture,
      transcriptFs: memFs().fsx,
    })
    await session.send("hi", { gate: createPermissionGate({ yes: true }) })
    const sendOptions = capture.mock.calls[0][2] as SendOptions
    expect(sendOptions.suppressApprovalForTools).toContain("mcp__cognia-tools__bash")
  })

  it("bootstraps once and reuses options + session across sends", async () => {
    const shutdown = jest.fn().mockResolvedValue(undefined)
    const boot = { transport: {} as never, shutdown } as unknown as SidecarBootstrap
    const bootstrap = jest.fn().mockResolvedValue(boot)
    const resolveOptions = jest.fn().mockResolvedValue({ model: "claude-x", provider: "anthropic" })
    const capture = jest
      .fn()
      .mockResolvedValueOnce(result("first"))
      .mockResolvedValueOnce(result("second"))

    const session = createAgentSession({
      config: cfg(),
      sessionId: "s_persist",
      home: HOME,
      now: () => 1000,
      bootstrap,
      resolveOptions,
      capture,
      transcriptFs: memFs().fsx,
    })

    const r1 = await session.send("hello", { gate: createPermissionGate({ yes: true }) })
    const r2 = await session.send("again", { gate: createPermissionGate({ yes: true }) })

    expect(r1.text).toBe("first")
    expect(r2.text).toBe("second")
    // bootstrap + resolveOptions happen exactly once across both turns.
    expect(bootstrap).toHaveBeenCalledTimes(1)
    expect(resolveOptions).toHaveBeenCalledTimes(1)
    // both turns reuse the same session id.
    expect(capture.mock.calls[0][0]).toBe("s_persist")
    expect(capture.mock.calls[1][0]).toBe("s_persist")
  })

  it("appends user + assistant turns to the transcript", async () => {
    const m = memFs()
    const boot = { transport: {} as never, shutdown: jest.fn() } as unknown as SidecarBootstrap
    const session = createAgentSession({
      config: cfg(),
      sessionId: "s1",
      home: HOME,
      now: () => 1,
      bootstrap: async () => boot,
      resolveOptions: async () => ({ provider: "anthropic" }) as never,
      capture: async () => result("ok"),
      transcriptFs: m.fsx,
    })
    await session.send("q1", { gate: createPermissionGate({ yes: true }) })
    const entries = readTranscript(HOME, "s1", m.fsx)
    expect(entries.map((e) => e.role)).toEqual(["user", "assistant"])
  })

  it("close shuts down the sidecar and blocks further sends", async () => {
    const shutdown = jest.fn().mockResolvedValue(undefined)
    const boot = { transport: {} as never, shutdown } as unknown as SidecarBootstrap
    const session = createAgentSession({
      config: cfg(),
      sessionId: "s1",
      home: HOME,
      bootstrap: async () => boot,
      resolveOptions: async () => ({}) as never,
      capture: async () => result("x"),
      transcriptFs: memFs().fsx,
    })
    await session.send("hi", { gate: createPermissionGate({ yes: true }) })
    await session.close()
    await session.close() // idempotent
    expect(shutdown).toHaveBeenCalledTimes(1)
    await expect(
      session.send("more", { gate: createPermissionGate({ yes: true }) })
    ).rejects.toThrow(/closed/)
  })

  it("never bootstraps if no send happens", async () => {
    const bootstrap = jest.fn()
    const session = createAgentSession({
      config: cfg(),
      home: HOME,
      bootstrap,
      transcriptFs: memFs().fsx,
    })
    await session.close()
    expect(bootstrap).not.toHaveBeenCalled()
  })

  it("mints a session id when none is given", () => {
    const session = createAgentSession({ config: cfg(), home: HOME, transcriptFs: memFs().fsx })
    expect(session.sessionId).toMatch(/^s_/)
  })
})
