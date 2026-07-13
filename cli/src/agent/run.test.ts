/**
 * @jest-environment node
 */
import { runHeadlessTurn, mintSessionId } from "./run"
import { readTranscript, type TranscriptFs } from "./transcript"
import { createPermissionGate } from "./permission-gate"
import { DEFAULT_RESOLVED_CONFIG, type ResolvedConfig } from "../config/schema"
import { DEFAULT_BUILTIN_TOOLS } from "@cognia/agent-config-types"
import type { SidecarBootstrap } from "../runtime/bootstrap"
import type { RunAndCaptureResult } from "@/lib/claude/run-and-capture"

const HOME = "/home/u/.cognia"

function cfg(p: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    ...DEFAULT_RESOLVED_CONFIG,
    builtinTools: { ...DEFAULT_BUILTIN_TOOLS },
    providers: { anthropic: { apiKey: "sk" } },
    cwd: "/work",
    model: "claude-x",
    ...p,
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

function fakeBoot() {
  const shutdown = jest.fn().mockResolvedValue(undefined)
  const boot = { transport: {} as never, shutdown } as unknown as SidecarBootstrap
  return { boot, shutdown }
}

function captureResult(over: Partial<RunAndCaptureResult> = {}): RunAndCaptureResult {
  return {
    text: "the reply",
    messageId: "m1",
    a2uiSurfaces: {},
    a2uiSurfaceOrder: [],
    usage: { inputTokens: 3, outputTokens: 4 } as RunAndCaptureResult["usage"],
    sdkSessionId: "sdk-1",
    ...over,
  }
}

describe("mintSessionId", () => {
  it("uses the s_ prefix and is deterministic given inputs", () => {
    expect(mintSessionId(0, 0.5)).toMatch(/^s_/)
    expect(mintSessionId(1000, 0.5)).toBe(mintSessionId(1000, 0.5))
  })
})

describe("runHeadlessTurn", () => {
  it("resolves options, captures, persists transcript, and shuts down", async () => {
    const m = memFs()
    const fb = fakeBoot()
    const resolveOptions = jest.fn().mockResolvedValue({ model: "claude-x", provider: "anthropic" })
    const capture = jest.fn().mockResolvedValue(captureResult())

    const res = await runHeadlessTurn({
      config: cfg(),
      prompt: "do it",
      sessionId: "s_fixed",
      gate: createPermissionGate({ yes: true }),
      home: HOME,
      now: 1234,
      bootstrap: async () => fb.boot,
      resolveOptions,
      capture,
      transcriptFs: m.fsx,
    })

    expect(res).toEqual({
      sessionId: "s_fixed",
      text: "the reply",
      usage: { inputTokens: 3, outputTokens: 4 },
      sdkSessionId: "sdk-1",
    })
    // resolveOptions saw a CLI ctx with the anthropic provider.
    expect(resolveOptions.mock.calls[0][0].session.providerOverride).toBe("anthropic")
    // capture got the session id, prompt, resolved options + the gate.
    const [sid, prompt, opts, cap] = capture.mock.calls[0]
    expect(sid).toBe("s_fixed")
    expect(prompt).toBe("do it")
    expect(opts).toMatchObject({ model: "claude-x", provider: "anthropic" })
    expect(typeof cap.onPermissionRequest).toBe("function")
    // transcript holds the user + assistant turns.
    const entries = readTranscript(HOME, "s_fixed", m.fsx)
    expect(entries.map((e) => e.role)).toEqual(["user", "assistant"])
    expect(entries[1].content).toBe("the reply")
    expect(entries[1].meta).toMatchObject({ provider: "anthropic", sdkSessionId: "sdk-1" })
    expect(fb.shutdown).toHaveBeenCalledTimes(1)
  })

  it("patches SendOptions.maxTurns from the --max-turns param", async () => {
    const fb = fakeBoot()
    const capture = jest.fn().mockResolvedValue(captureResult())
    await runHeadlessTurn({
      config: cfg(),
      prompt: "x",
      sessionId: "s1",
      gate: createPermissionGate({ yes: true }),
      home: HOME,
      maxTurns: 5,
      bootstrap: async () => fb.boot,
      resolveOptions: async () => ({ model: "m", provider: "anthropic" }) as never,
      capture,
      transcriptFs: memFs().fsx,
    })
    expect(capture.mock.calls[0][2]).toMatchObject({ maxTurns: 5 })
  })

  it("appends the twin stable+dynamic segments to the system prompt when configured", async () => {
    const fb = fakeBoot()
    const capture = jest.fn().mockResolvedValue(captureResult())
    const fetchTwin = jest.fn().mockResolvedValue({
      ok: true,
      applied: { systemPrompt: "SP-FULL", stable: "TWIN-STABLE", dynamic: "TWIN-DYN" },
      degraded: false,
      sources: [],
      styleSampleCount: 0,
    })
    await runHeadlessTurn({
      config: cfg({ twin: { enabled: true, characterId: "char-1" } }),
      prompt: "ground me",
      sessionId: "s_twin",
      gate: createPermissionGate({ yes: true }),
      home: HOME,
      bootstrap: async () => fb.boot,
      resolveOptions: async () =>
        ({ model: "m", provider: "anthropic", systemPrompt: "BASE" }) as never,
      capture,
      transcriptFs: memFs().fsx,
      fetchTwin: fetchTwin as never,
    })
    expect(fetchTwin).toHaveBeenCalledWith({
      characterId: "char-1",
      message: "ground me",
      sessionId: "s_twin",
    })
    expect(capture.mock.calls[0][2]).toMatchObject({
      systemPrompt: "BASE\n\nTWIN-STABLE\n\nTWIN-DYN",
    })
  })

  it("proceeds ungrounded when the twin fetch fails", async () => {
    const fb = fakeBoot()
    const capture = jest.fn().mockResolvedValue(captureResult())
    await runHeadlessTurn({
      config: cfg({ twin: { enabled: true, characterId: "char-1" } }),
      prompt: "x",
      sessionId: "s1",
      gate: createPermissionGate({ yes: true }),
      home: HOME,
      bootstrap: async () => fb.boot,
      resolveOptions: async () =>
        ({ model: "m", provider: "anthropic", systemPrompt: "BASE" }) as never,
      capture,
      transcriptFs: memFs().fsx,
      fetchTwin: (async () => null) as never,
    })
    expect(capture.mock.calls[0][2]).toMatchObject({ systemPrompt: "BASE" })
  })

  it("hydrates the plugin runtime when devPlugins is on (even without pluginTools)", async () => {
    const fb = fakeBoot()
    const loadPluginRuntime = jest.fn(async () => undefined)
    await runHeadlessTurn({
      config: cfg({ devPlugins: true }),
      prompt: "x",
      sessionId: "s1",
      gate: createPermissionGate({ yes: true }),
      home: HOME,
      devPluginsDir: "/repo/plugins",
      bootstrap: async () => fb.boot,
      resolveOptions: async () => ({ model: "m", provider: "anthropic" }) as never,
      capture: async () => captureResult(),
      loadPluginRuntime,
      subscribePluginTools: async () => jest.fn(async () => undefined),
      transcriptFs: memFs().fsx,
    })
    expect(loadPluginRuntime).toHaveBeenCalledTimes(1)
  })

  it("mints a session id when none is provided", async () => {
    const fb = fakeBoot()
    const res = await runHeadlessTurn({
      config: cfg(),
      prompt: "x",
      gate: createPermissionGate({ yes: true }),
      home: HOME,
      now: 42,
      bootstrap: async () => fb.boot,
      resolveOptions: async () => ({}) as never,
      capture: async () => captureResult({ sdkSessionId: undefined, usage: undefined }),
      transcriptFs: memFs().fsx,
    })
    expect(res.sessionId).toMatch(/^s_/)
  })

  it("loads the plugin runtime before resolving options and subscribes the dispatcher when pluginTools is on", async () => {
    const fb = fakeBoot()
    const order: string[] = []
    const unsub = jest.fn(async () => void order.push("unsub"))
    const loadPluginRuntime = jest.fn(async () => void order.push("load"))
    const subscribePluginTools = jest.fn(async () => {
      order.push("subscribe")
      return unsub
    })
    const resolveOptions = jest.fn(async () => {
      order.push("resolve")
      return { model: "m", provider: "anthropic" } as never
    })
    const capture = jest.fn(async () => {
      order.push("capture")
      return captureResult()
    })

    await runHeadlessTurn({
      config: cfg({ pluginTools: true }),
      prompt: "x",
      sessionId: "s1",
      gate: createPermissionGate({ yes: true }),
      home: HOME,
      bootstrap: async () => {
        order.push("bootstrap")
        return fb.boot
      },
      resolveOptions,
      capture,
      loadPluginRuntime,
      subscribePluginTools,
      transcriptFs: memFs().fsx,
    })

    expect(loadPluginRuntime).toHaveBeenCalledTimes(1)
    expect(subscribePluginTools).toHaveBeenCalledTimes(1)
    expect(unsub).toHaveBeenCalledTimes(1)
    // The manifest is built inside resolveOptions, so the runtime must hydrate
    // first; the dispatcher needs the live transport, so it subscribes after
    // bootstrap; the unsubscribe runs after the turn completes.
    expect(order.indexOf("load")).toBeLessThan(order.indexOf("resolve"))
    expect(order.indexOf("subscribe")).toBeGreaterThan(order.indexOf("bootstrap"))
    expect(order.indexOf("unsub")).toBeGreaterThan(order.indexOf("capture"))
  })

  it("threads configured MCP servers and enabled skills into the build context", async () => {
    const fb = fakeBoot()
    const resolveOptions = jest.fn().mockResolvedValue({ model: "m", provider: "anthropic" })
    const ensureDb = jest.fn().mockResolvedValue(undefined)
    await runHeadlessTurn({
      config: cfg(),
      prompt: "x",
      sessionId: "s1",
      gate: createPermissionGate({ yes: true }),
      home: HOME,
      bootstrap: async () => fb.boot,
      resolveOptions,
      capture: async () => captureResult(),
      resolveMcpServers: () => [
        {
          id: "mcp_fs",
          name: "fs",
          transport: "stdio",
          config: {},
          enabled: true,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      resolveSkillIds: () => ["skill_x"],
      ensureDb,
      transcriptFs: memFs().fsx,
    })
    const ctx = resolveOptions.mock.calls[0][0]
    expect(ctx.preloadedMcpServers.map((s: { name: string }) => s.name)).toEqual(["fs"])
    expect(ctx.ephemeralSkillIds).toEqual(["skill_x"])
    // Skills are read from Dexie in build-options, so the CLI db is opened first.
    expect(ensureDb).toHaveBeenCalledTimes(1)
  })

  it("does not open the db when no skills are enabled", async () => {
    const fb = fakeBoot()
    const ensureDb = jest.fn()
    await runHeadlessTurn({
      config: cfg(),
      prompt: "x",
      sessionId: "s1",
      gate: createPermissionGate({ yes: true }),
      home: HOME,
      bootstrap: async () => fb.boot,
      resolveOptions: async () => ({ model: "m", provider: "anthropic" }) as never,
      capture: async () => captureResult(),
      resolveMcpServers: () => [],
      resolveSkillIds: () => [],
      ensureDb,
      transcriptFs: memFs().fsx,
    })
    expect(ensureDb).not.toHaveBeenCalled()
  })

  it("drops skills but still runs the turn when opening the db fails", async () => {
    const fb = fakeBoot()
    const resolveOptions = jest.fn().mockResolvedValue({ model: "m", provider: "anthropic" })
    const res = await runHeadlessTurn({
      config: cfg(),
      prompt: "x",
      sessionId: "s1",
      gate: createPermissionGate({ yes: true }),
      home: HOME,
      bootstrap: async () => fb.boot,
      resolveOptions,
      capture: async () => captureResult(),
      resolveSkillIds: () => ["skill_x"],
      ensureDb: async () => {
        throw new Error("db locked")
      },
      transcriptFs: memFs().fsx,
    })
    expect(res.text).toBe("the reply")
    const ctx = resolveOptions.mock.calls[0][0]
    expect(ctx.ephemeralSkillIds ?? []).toEqual([])
  })

  it("does not touch the plugin runtime when pluginTools is off and no skills are enabled", async () => {
    const fb = fakeBoot()
    const loadPluginRuntime = jest.fn()
    const subscribePluginTools = jest.fn()
    await runHeadlessTurn({
      config: cfg(),
      prompt: "x",
      sessionId: "s1",
      gate: createPermissionGate({ yes: true }),
      home: HOME,
      bootstrap: async () => fb.boot,
      resolveOptions: async () => ({}) as never,
      capture: async () => captureResult(),
      // No skills enabled → the name-only `load_skill` tool isn't surfaced either,
      // so the dispatcher stays unsubscribed (the pure pluginTools-off path).
      resolveSkillIds: () => [],
      loadPluginRuntime,
      subscribePluginTools,
      transcriptFs: memFs().fsx,
    })
    expect(loadPluginRuntime).not.toHaveBeenCalled()
    expect(subscribePluginTools).not.toHaveBeenCalled()
  })

  it("surfaces the load_skill tool + subscribes the dispatcher in name mode with skills, even when pluginTools is off", async () => {
    const fb = fakeBoot()
    const resolveOptions = jest.fn().mockResolvedValue({ model: "m", provider: "anthropic" })
    const subscribePluginTools = jest.fn().mockResolvedValue(jest.fn())
    await runHeadlessTurn({
      config: cfg(),
      prompt: "x",
      sessionId: "s1",
      gate: createPermissionGate({ yes: true }),
      home: HOME,
      bootstrap: async () => fb.boot,
      resolveOptions,
      capture: async () => captureResult(),
      resolveSkillIds: () => ["skill_x"],
      ensureDb: async () => undefined,
      subscribePluginTools,
      transcriptFs: memFs().fsx,
    })
    const opts = await resolveOptions.mock.results[0].value
    expect((opts.pluginTools ?? []).map((t: { name: string }) => t.name)).toContain("load_skill")
    expect(subscribePluginTools).toHaveBeenCalledTimes(1)
  })

  it("uses full skill loading without the load_skill tool when skillLoadMode is 'full'", async () => {
    const fb = fakeBoot()
    const resolveOptions = jest.fn().mockResolvedValue({ model: "m", provider: "anthropic" })
    const subscribePluginTools = jest.fn().mockResolvedValue(jest.fn())
    await runHeadlessTurn({
      config: cfg({ skillLoadMode: "full" }),
      prompt: "x",
      sessionId: "s1",
      gate: createPermissionGate({ yes: true }),
      home: HOME,
      bootstrap: async () => fb.boot,
      resolveOptions,
      capture: async () => captureResult(),
      resolveSkillIds: () => ["skill_x"],
      ensureDb: async () => undefined,
      subscribePluginTools,
      transcriptFs: memFs().fsx,
    })
    const opts = await resolveOptions.mock.results[0].value
    expect((opts.pluginTools ?? []).map((t: { name: string }) => t.name)).not.toContain(
      "load_skill"
    )
    expect(subscribePluginTools).not.toHaveBeenCalled()
  })

  it("still shuts down the sidecar when capture throws", async () => {
    const fb = fakeBoot()
    await expect(
      runHeadlessTurn({
        config: cfg(),
        prompt: "x",
        sessionId: "s1",
        gate: createPermissionGate({ yes: true }),
        home: HOME,
        bootstrap: async () => fb.boot,
        resolveOptions: async () => ({}) as never,
        capture: async () => {
          throw new Error("turn failed")
        },
        transcriptFs: memFs().fsx,
      })
    ).rejects.toThrow("turn failed")
    expect(fb.shutdown).toHaveBeenCalledTimes(1)
  })
})
