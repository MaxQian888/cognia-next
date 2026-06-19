/**
 * @jest-environment node
 */
import {
  createAgentSession,
  withCliAutoApprovedTools,
  CLI_AUTO_APPROVED_TOOLS,
  type AttachmentSummary,
} from "./session-runner"
import type { SendOptions } from "@/lib/claude/types"
import { createPermissionGate } from "./permission-gate"
import { readTranscript, type TranscriptFs } from "./transcript"
import { DEFAULT_RESOLVED_CONFIG, type ResolvedConfig } from "../config/schema"
import { DEFAULT_BUILTIN_TOOLS } from "@/lib/claude/types"
import type { SidecarBootstrap } from "../runtime/bootstrap"
import type { RunAndCaptureResult } from "@/lib/claude/run-and-capture"

const HOME = "/home/u/.cognia"

function cfg(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    ...DEFAULT_RESOLVED_CONFIG,
    builtinTools: { ...DEFAULT_BUILTIN_TOOLS },
    providers: { anthropic: { apiKey: "sk" } },
    cwd: "/work",
    model: "claude-x",
    ...overrides,
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

  it("passes multimodal content (from buildContent) to capture, not the raw string", async () => {
    const capture = jest.fn().mockResolvedValue(result("ok"))
    const blocks = [
      { type: "text", text: "look @a.png" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } },
    ]
    const session = createAgentSession({
      config: cfg(),
      sessionId: "s_img",
      home: HOME,
      now: () => 1000,
      bootstrap: jest
        .fn()
        .mockResolvedValue({ transport: {}, shutdown: jest.fn() } as unknown as SidecarBootstrap),
      resolveOptions: async () => ({ model: "m", provider: "anthropic" }) as never,
      capture,
      transcriptFs: memFs().fsx,
      buildContent: () => ({
        content: blocks as never,
        imageCount: 1,
        documentCount: 0,
        injectedFiles: [],
        ocr: [],
        failed: [],
        skipped: [],
      }),
    })
    await session.send("look @a.png", { gate: createPermissionGate({ yes: true }) })
    expect(capture.mock.calls[0][1]).toBe(blocks)
  })

  it("awaits an async buildContent and sends a native PDF document block", async () => {
    const capture = jest.fn().mockResolvedValue(result("ok"))
    const blocks = [
      { type: "text", text: "read @spec.pdf" },
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: "PDF" } },
    ]
    const session = createAgentSession({
      config: cfg(),
      sessionId: "s_pdf",
      home: HOME,
      now: () => 1000,
      bootstrap: jest
        .fn()
        .mockResolvedValue({ transport: {}, shutdown: jest.fn() } as unknown as SidecarBootstrap),
      resolveOptions: async () => ({ model: "claude-opus-4-5", provider: "anthropic" }) as never,
      capture,
      transcriptFs: memFs().fsx,
      buildContent: async () => ({
        content: blocks as never,
        imageCount: 0,
        documentCount: 1,
        injectedFiles: [],
        ocr: [],
        failed: [],
        skipped: [],
      }),
    })
    await session.send("read @spec.pdf", { gate: createPermissionGate({ yes: true }) })
    const sent = capture.mock.calls[0][1] as Array<{ type: string }>
    expect(sent.some((b) => b.type === "document")).toBe(true)
  })

  it("reports an attachment summary, and stays silent when there is nothing to report", async () => {
    const capture = jest.fn().mockResolvedValue(result("ok"))
    const mkSession = (
      buildContent: NonNullable<Parameters<typeof createAgentSession>[0]["buildContent"]>,
      sessionId: string
    ) =>
      createAgentSession({
        config: cfg(),
        sessionId,
        home: HOME,
        now: () => 1000,
        bootstrap: jest
          .fn()
          .mockResolvedValue({ transport: {}, shutdown: jest.fn() } as unknown as SidecarBootstrap),
        resolveOptions: async () => ({ model: "m", provider: "anthropic" }) as never,
        capture,
        transcriptFs: memFs().fsx,
        buildContent,
      })

    const withNews = mkSession(
      async (prompt) => ({
        content: `${prompt}\n\n<file path="a.md">\nx\n</file>`,
        imageCount: 0,
        documentCount: 0,
        injectedFiles: ["a.md"],
        ocr: [],
        failed: ["b.zip"],
        skipped: ["b.zip"],
      }),
      "s_attach1"
    )
    const got: AttachmentSummary[] = []
    await withNews.send("see @a.md @b.zip", {
      gate: createPermissionGate({ yes: true }),
      onAttachments: (s) => got.push(s),
    })
    expect(got).toHaveLength(1)
    expect(got[0].injectedFiles).toEqual(["a.md"])
    expect(got[0].failed).toEqual(["b.zip"])

    const noNews = mkSession(
      async (prompt) => ({
        content: prompt,
        imageCount: 0,
        documentCount: 0,
        injectedFiles: [],
        ocr: [],
        failed: [],
        skipped: [],
      }),
      "s_attach2"
    )
    const got2: AttachmentSummary[] = []
    await noNews.send("hi", {
      gate: createPermissionGate({ yes: true }),
      onAttachments: (s) => got2.push(s),
    })
    expect(got2).toHaveLength(0)
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

  it("hydrates the plugin runtime before options and subscribes after bootstrap when pluginTools is on", async () => {
    const order: string[] = []
    const unsub = jest.fn().mockResolvedValue(undefined)
    const boot = {
      transport: {} as never,
      shutdown: jest.fn().mockResolvedValue(undefined),
    } as unknown as SidecarBootstrap
    const session = createAgentSession({
      config: { ...cfg(), pluginTools: true },
      home: HOME,
      transcriptFs: memFs().fsx,
      bootstrap: jest.fn(async () => {
        order.push("bootstrap")
        return boot
      }),
      resolveOptions: jest.fn(async () => {
        order.push("resolveOptions")
        return { model: "claude-x", provider: "anthropic" } as SendOptions
      }),
      capture: jest.fn(async () => result("ok")),
      loadPluginRuntime: jest.fn(async () => {
        order.push("loadPluginRuntime")
        return { ok: true }
      }),
      subscribePluginTools: jest.fn(async () => {
        order.push("subscribe")
        return unsub
      }),
    })
    await session.send("hi", { gate: createPermissionGate({ yes: true }) })
    // Plugin runtime hydrates BEFORE options (so the manifest is populated) and
    // the executor subscribes only AFTER the transport is live.
    expect(order).toEqual(["loadPluginRuntime", "resolveOptions", "bootstrap", "subscribe"])
    await session.close()
    expect(unsub).toHaveBeenCalledTimes(1)
  })

  it("opens the CLI-local db before resolving options when skills are enabled", async () => {
    // Regression: skills carried over in the `/skill` state file make the
    // build-options pipeline read `listEnabledSkillsByIds` from Dexie via
    // `getDb()`, which throws "getDb() called on the server" unless the db (and
    // its window/IndexedDB shims) is open first. The send path must open it.
    const order: string[] = []
    const ensureDb = jest.fn(async () => {
      order.push("ensureDb")
    })
    const session = createAgentSession({
      config: cfg(),
      home: HOME,
      transcriptFs: memFs().fsx,
      resolveSkillIds: () => ["skill-a"],
      ensureDb,
      bootstrap: jest.fn().mockResolvedValue({
        transport: {} as never,
        shutdown: jest.fn().mockResolvedValue(undefined),
      } as unknown as SidecarBootstrap),
      resolveOptions: jest.fn(async () => {
        order.push("resolveOptions")
        return { model: "claude-x", provider: "anthropic" } as SendOptions
      }),
      capture: jest.fn(async () => result("ok")),
    })
    await session.send("hi", { gate: createPermissionGate({ yes: true }) })
    expect(ensureDb).toHaveBeenCalledTimes(1)
    // The db must be open BEFORE options resolve (which reads the skill rows).
    expect(order).toEqual(["ensureDb", "resolveOptions"])
  })

  it("does not open the CLI-local db when no skills are enabled (plain chat pays nothing)", async () => {
    const ensureDb = jest.fn()
    const session = createAgentSession({
      config: cfg(),
      home: HOME,
      transcriptFs: memFs().fsx,
      resolveSkillIds: () => [],
      ensureDb,
      bootstrap: jest.fn().mockResolvedValue({
        transport: {} as never,
        shutdown: jest.fn().mockResolvedValue(undefined),
      } as unknown as SidecarBootstrap),
      resolveOptions: jest.fn().mockResolvedValue({ model: "claude-x", provider: "anthropic" }),
      capture: jest.fn(async () => result("ok")),
    })
    await session.send("hi", { gate: createPermissionGate({ yes: true }) })
    expect(ensureDb).not.toHaveBeenCalled()
  })

  it("degrades to no skills (no crash) when opening the CLI-local db fails", async () => {
    // Hardening: a failed db open must NOT crash the turn. Options resolve
    // without skills so chat still works.
    const ensureDb = jest.fn().mockRejectedValue(new Error("snapshot corrupt"))
    const resolveOptions = jest.fn(
      async (..._args: unknown[]) => ({ provider: "anthropic" }) as SendOptions
    )
    const session = createAgentSession({
      config: cfg(),
      home: HOME,
      transcriptFs: memFs().fsx,
      resolveSkillIds: () => ["skill-a"],
      ensureDb,
      bootstrap: jest.fn().mockResolvedValue({
        transport: {} as never,
        shutdown: jest.fn().mockResolvedValue(undefined),
      } as unknown as SidecarBootstrap),
      resolveOptions,
      capture: jest.fn(async () => result("ok")),
    })
    const r = await session.send("hi", { gate: createPermissionGate({ yes: true }) })
    expect(r.text).toBe("ok")
    // Options resolved with NO skills (the failing db forced a degrade).
    const ctx = resolveOptions.mock.calls[0][0] as { ephemeralSkillIds?: string[] }
    expect(ctx.ephemeralSkillIds ?? []).toEqual([])
  })

  it("announces the active skills once, with the resolved ids", async () => {
    const onActiveSkills = jest.fn()
    const session = createAgentSession({
      config: cfg(),
      home: HOME,
      transcriptFs: memFs().fsx,
      resolveSkillIds: () => ["builtin:web-search"],
      ensureDb: jest.fn(async () => undefined),
      bootstrap: jest.fn().mockResolvedValue({
        transport: {} as never,
        shutdown: jest.fn().mockResolvedValue(undefined),
      } as unknown as SidecarBootstrap),
      resolveOptions: async () => ({ provider: "anthropic" }) as SendOptions,
      capture: jest.fn(async () => result("ok")),
    })
    await session.send("one", { gate: createPermissionGate({ yes: true }), onActiveSkills })
    await session.send("two", { gate: createPermissionGate({ yes: true }), onActiveSkills })
    // Announced exactly once across both turns, with the enabled ids.
    expect(onActiveSkills).toHaveBeenCalledTimes(1)
    expect(onActiveSkills).toHaveBeenCalledWith(["builtin:web-search"])
  })

  it("never announces skills for plain (skill-less) chat", async () => {
    const onActiveSkills = jest.fn()
    const session = createAgentSession({
      config: cfg(),
      home: HOME,
      transcriptFs: memFs().fsx,
      resolveSkillIds: () => [],
      bootstrap: jest.fn().mockResolvedValue({
        transport: {} as never,
        shutdown: jest.fn().mockResolvedValue(undefined),
      } as unknown as SidecarBootstrap),
      resolveOptions: async () => ({ provider: "anthropic" }) as SendOptions,
      capture: jest.fn(async () => result("ok")),
    })
    await session.send("hi", { gate: createPermissionGate({ yes: true }), onActiveSkills })
    expect(onActiveSkills).not.toHaveBeenCalled()
  })

  it("re-announces skills after invalidateOptions (e.g. a /skill toggle)", async () => {
    const onActiveSkills = jest.fn()
    const session = createAgentSession({
      config: cfg(),
      home: HOME,
      transcriptFs: memFs().fsx,
      resolveSkillIds: () => ["builtin:a"],
      ensureDb: jest.fn(async () => undefined),
      bootstrap: jest.fn().mockResolvedValue({
        transport: {} as never,
        shutdown: jest.fn().mockResolvedValue(undefined),
      } as unknown as SidecarBootstrap),
      resolveOptions: async () => ({ provider: "anthropic" }) as SendOptions,
      capture: jest.fn(async () => result("ok")),
    })
    await session.send("one", { gate: createPermissionGate({ yes: true }), onActiveSkills })
    session.invalidateOptions?.()
    await session.send("two", { gate: createPermissionGate({ yes: true }), onActiveSkills })
    expect(onActiveSkills).toHaveBeenCalledTimes(2)
  })

  it("does not load the plugin runtime when pluginTools is off, but subscribes the executor for web tools", async () => {
    const loadPluginRuntime = jest.fn()
    const subscribePluginTools = jest.fn().mockResolvedValue(() => {})
    const session = createAgentSession({
      config: cfg(), // pluginTools undefined → off; webTools default on
      home: HOME,
      transcriptFs: memFs().fsx,
      bootstrap: jest.fn().mockResolvedValue({
        transport: {} as never,
        shutdown: jest.fn().mockResolvedValue(undefined),
      } as unknown as SidecarBootstrap),
      resolveOptions: jest.fn().mockResolvedValue({ model: "claude-x", provider: "anthropic" }),
      capture: jest.fn(async () => result("ok")),
      loadPluginRuntime,
      subscribePluginTools,
    })
    await session.send("hi", { gate: createPermissionGate({ yes: true }) })
    // The plugin RUNTIME stays unloaded (web tools bypass the plugin registry)…
    expect(loadPluginRuntime).not.toHaveBeenCalled()
    // …but the executor IS subscribed so web_search / web_fetch round-trip.
    expect(subscribePluginTools).toHaveBeenCalledTimes(1)
  })

  it("subscribes the executor exactly once when both plugin and web tools are on", async () => {
    const subscribePluginTools = jest.fn().mockResolvedValue(() => {})
    const session = createAgentSession({
      config: cfg({ pluginTools: true }),
      home: HOME,
      transcriptFs: memFs().fsx,
      bootstrap: jest.fn().mockResolvedValue({
        transport: {} as never,
        shutdown: jest.fn().mockResolvedValue(undefined),
      } as unknown as SidecarBootstrap),
      resolveOptions: jest.fn().mockResolvedValue({ model: "claude-x", provider: "anthropic" }),
      capture: jest.fn(async () => result("ok")),
      loadPluginRuntime: jest.fn().mockResolvedValue(undefined),
      subscribePluginTools,
    })
    await session.send("hi", { gate: createPermissionGate({ yes: true }) })
    await session.send("again", { gate: createPermissionGate({ yes: true }) })
    expect(subscribePluginTools).toHaveBeenCalledTimes(1)
  })

  it("does not subscribe the executor when both plugin and web tools are off", async () => {
    const subscribePluginTools = jest.fn().mockResolvedValue(() => {})
    const session = createAgentSession({
      config: cfg({ webTools: false }), // pluginTools off (default) + webTools off
      home: HOME,
      transcriptFs: memFs().fsx,
      bootstrap: jest.fn().mockResolvedValue({
        transport: {} as never,
        shutdown: jest.fn().mockResolvedValue(undefined),
      } as unknown as SidecarBootstrap),
      resolveOptions: jest.fn().mockResolvedValue({ model: "claude-x", provider: "anthropic" }),
      capture: jest.fn(async () => result("ok")),
      subscribePluginTools,
    })
    await session.send("hi", { gate: createPermissionGate({ yes: true }) })
    expect(subscribePluginTools).not.toHaveBeenCalled()
  })
})

describe("createAgentSession.setPermissionMode", () => {
  it("no-ops before the sidecar has spawned (no control message, no throw)", async () => {
    const setSessionMode = jest.fn().mockResolvedValue(undefined)
    const session = createAgentSession({
      config: cfg(),
      sessionId: "s_mode",
      home: HOME,
      transcriptFs: memFs().fsx,
      bootstrap: jest.fn(),
      resolveOptions: async () => ({ model: "m", provider: "anthropic" }) as never,
      capture: jest.fn(async () => result("ok")),
      setSessionMode,
    })
    await session.setPermissionMode!("plan")
    expect(setSessionMode).not.toHaveBeenCalled()
  })

  it("sends the control message on a live session without respawning", async () => {
    const setSessionMode = jest.fn().mockResolvedValue(undefined)
    const bootstrap = jest
      .fn()
      .mockResolvedValue({ transport: {}, shutdown: jest.fn() } as unknown as SidecarBootstrap)
    const capture = jest.fn(async (..._args: unknown[]) => result("ok"))
    const session = createAgentSession({
      config: cfg(),
      sessionId: "s_mode_live",
      home: HOME,
      transcriptFs: memFs().fsx,
      bootstrap,
      resolveOptions: async () => ({ model: "m", provider: "anthropic" }) as never,
      capture,
      setSessionMode,
    })
    // Spawn the sidecar with the first turn.
    await session.send("hi", { gate: createPermissionGate({ yes: true }) })
    expect(bootstrap).toHaveBeenCalledTimes(1)

    await session.setPermissionMode!("acceptEdits")
    expect(setSessionMode).toHaveBeenCalledWith("s_mode_live", "acceptEdits")

    // A follow-up turn reuses the same sidecar (no respawn) and the cached
    // options now carry the live mode.
    await session.send("again", { gate: createPermissionGate({ yes: true }) })
    expect(bootstrap).toHaveBeenCalledTimes(1)
    const followUpOptions = capture.mock.calls[1][2] as SendOptions
    expect(followUpOptions.permissionMode).toBe("acceptEdits")
  })
})
