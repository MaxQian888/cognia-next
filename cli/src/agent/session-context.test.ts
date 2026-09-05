/**
 * @jest-environment node
 */
import type { McpServer, SendOptions } from "@cognia/agent-config-types"
import { DEFAULT_BUILTIN_TOOLS } from "@cognia/agent-config-types"

import { createCliContextAssembler, prependTextBlock, twinContextBlock } from "./session-context"
import { DEFAULT_RESOLVED_CONFIG, type ResolvedConfig } from "../config/schema"
import { CliDbSnapshotError } from "../db/bootstrap"
import type { AgentSummary } from "./discover-agents"
import { DISPATCH_AGENT_TOOL_NAME } from "@/lib/claude/agents/dispatch-agent-tool"
import { LOAD_SKILL_RESOURCE_TOOL_NAME, LOAD_SKILL_TOOL_NAME } from "./skill-load-tool"
import type { BuiltAttachmentContent } from "./attachments/build"
import type { TwinContextResult } from "../twin/context-client"

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

const subagent = (id: string): AgentSummary => ({
  id,
  name: id,
  description: `${id} agent`,
  def: { id, name: id, description: `${id} agent`, prompt: `p-${id}` },
})

/** A minimal successful twin response. */
const twin = (applied: { stable?: string; dynamic?: string }): TwinContextResult => ({
  ok: true,
  applied: { systemPrompt: applied.stable ?? "", ...applied },
  degraded: false,
  sources: [],
  styleSampleCount: 0,
})

const emptyContent = (prompt: string): BuiltAttachmentContent => ({
  content: prompt,
  imageCount: 0,
  documentCount: 0,
  injectedFiles: [],
  ocr: [],
  failed: [],
  skipped: [],
})

/** Assembler with every disk/network seam stubbed. */
function makeAssembler(
  overrides: Partial<Parameters<typeof createCliContextAssembler>[0]> = {},
  config = cfg()
) {
  return createCliContextAssembler({
    config,
    sessionId: "s1",
    home: HOME,
    now: () => 1_700_000_000_000,
    resolveOptions: async () => ({ systemPrompt: "sys", model: "claude-x" }) as SendOptions,
    buildContent: (prompt) => emptyContent(prompt),
    resolveMcpServers: () => [],
    resolveSkillIds: () => [],
    resolveLoadableSkills: async () => [],
    resolveDisabledMcpTools: () => new Set<string>(),
    ensureDb: async () => undefined,
    resolveApprovedTools: () => new Set<string>(),
    loadPluginRuntime: async () => undefined,
    resolveAgents: async () => [],
    resolveAgentMode: async () => null,
    fetchTwin: async () => null,
    ...overrides,
  })
}

describe("createCliContextAssembler — session context", () => {
  it("rejects failed plugin startup before resolving tools and allows a clean retry", async () => {
    let attempts = 0
    const resolveOptions = jest.fn(async () => ({ model: "claude-x" }) as SendOptions)
    const assembler = makeAssembler(
      {
        resolveOptions,
        loadPluginRuntime: async () =>
          ++attempts === 1
            ? { ok: false, toolCount: 0, error: "Cannot find package lib0" }
            : { ok: true, toolCount: 4 },
      },
      cfg({ pluginTools: true })
    )
    await expect(assembler.resolveSession()).rejects.toMatchObject({
      code: "plugin_runtime_unavailable",
      retryable: true,
      message: expect.stringContaining("Cannot find package lib0"),
    })
    expect(resolveOptions).not.toHaveBeenCalled()
    expect(assembler.peek()).toBeNull()
    await expect(assembler.resolveSession()).resolves.toBeDefined()
    expect(resolveOptions).toHaveBeenCalledTimes(1)
  })
  it("resolves once and caches; invalidate forces a re-resolve", async () => {
    let calls = 0
    const assembler = makeAssembler({
      resolveOptions: async () => {
        calls += 1
        return { systemPrompt: `sys-${calls}` } as SendOptions
      },
    })
    const first = await assembler.resolveSession()
    expect(await assembler.resolveSession()).toBe(first)
    expect(calls).toBe(1)
    assembler.invalidate()
    const second = await assembler.resolveSession()
    expect(second).not.toBe(first)
    expect(calls).toBe(2)
  })

  it("dedupes concurrent first resolves so the plugin runtime hydrates once", async () => {
    let hydrations = 0
    const assembler = makeAssembler(
      { loadPluginRuntime: async () => void (hydrations += 1) },
      cfg({ pluginTools: true })
    )
    const [a, b] = await Promise.all([assembler.resolveSession(), assembler.resolveSession()])
    expect(a).toBe(b)
    expect(hydrations).toBe(1)
  })

  it("loads the plugin runtime for a sandboxed session even without pluginTools", async () => {
    // The four `sandbox_*` tools ARE plugin tools, and sandbox mode denies the
    // unsandboxed Bash / Edit / Write. Without the runtime the model reaches
    // the turn with no shell tool at all, and the OS-tier executor, which the
    // same bootstrap registers, is never installed either.
    let hydrations = 0
    const assembler = makeAssembler(
      { loadPluginRuntime: async () => void (hydrations += 1) },
      cfg({ sandbox: { enabled: true } })
    )
    await assembler.resolveSession()
    expect(hydrations).toBe(1)
  })

  it("does not load it for a sandbox block that only sets a ceiling", async () => {
    // A policy with `enabled` unset is a ceiling for Computer Use confinement,
    // not a request to swap the shell tools.
    let hydrations = 0
    const assembler = makeAssembler(
      { loadPluginRuntime: async () => void (hydrations += 1) },
      cfg({ sandbox: { policy: { network: "off" } } })
    )
    await assembler.resolveSession()
    expect(hydrations).toBe(0)
  })

  it("peek stays null until the first resolve", async () => {
    const assembler = makeAssembler()
    expect(assembler.peek()).toBeNull()
    const ctx = await assembler.resolveSession()
    expect(assembler.peek()).toBe(ctx)
    assembler.invalidate()
    expect(assembler.peek()).toBeNull()
  })

  it("surfaces dispatch_agent and drops the desktop SDK-native agents map", async () => {
    const assembler = makeAssembler({
      resolveOptions: async () =>
        ({ systemPrompt: "sys", agents: { desktop: {} } }) as unknown as SendOptions,
      resolveAgents: async () => [subagent("explorer")],
    })
    const ctx = await assembler.resolveSession()
    expect(ctx.subagentToolEnabled).toBe(true)
    expect(ctx.sendOptions.pluginTools?.map((t) => t.name)).toContain(DISPATCH_AGENT_TOOL_NAME)
    expect((ctx.sendOptions as Record<string, unknown>).agents).toBeUndefined()
    expect(ctx.agents.map((a) => a.id)).toEqual(["explorer"])
  })

  it("advertises no dispatch tool when there are no dispatchable subagents", async () => {
    const ctx = await makeAssembler({ resolveAgents: async () => [] }).resolveSession()
    expect(ctx.subagentToolEnabled).toBe(false)
    expect(ctx.sendOptions.pluginTools?.map((t) => t.name) ?? []).not.toContain(
      DISPATCH_AGENT_TOOL_NAME
    )
  })

  it("adds load_skill only in name mode with at least one enabled skill", async () => {
    const nameMode = await makeAssembler(
      { resolveSkillIds: () => ["skill-a"] },
      cfg({ skillLoadMode: "name" })
    ).resolveSession()
    expect(nameMode.sendOptions.pluginTools?.map((t) => t.name)).toContain(LOAD_SKILL_TOOL_NAME)
    expect(nameMode.sendOptions.pluginTools?.map((t) => t.name)).toContain(
      LOAD_SKILL_RESOURCE_TOOL_NAME
    )
    expect(nameMode.activeSkillIds).toEqual(["skill-a"])

    const fullMode = await makeAssembler(
      { resolveSkillIds: () => ["skill-a"] },
      cfg({ skillLoadMode: "full" })
    ).resolveSession()
    expect(fullMode.sendOptions.pluginTools?.map((t) => t.name) ?? []).not.toContain(
      LOAD_SKILL_TOOL_NAME
    )
  })

  it("degrades to no skills — and records the snapshot error — when the db is unsafe", async () => {
    const err = new CliDbSnapshotError("corrupt", "/tmp/snapshot", "/tmp/preserved")
    const ctx = await makeAssembler({
      resolveSkillIds: () => ["skill-a"],
      ensureDb: async () => {
        throw err
      },
    }).resolveSession()
    expect(ctx.activeSkillIds).toEqual([])
    expect(ctx.databaseError).toBe(err)
  })

  it("keeps a transient db failure silent (no snapshot error surfaced)", async () => {
    const ctx = await makeAssembler({
      resolveSkillIds: () => ["skill-a"],
      ensureDb: async () => {
        throw new Error("locked")
      },
    }).resolveSession()
    expect(ctx.activeSkillIds).toEqual([])
    expect(ctx.databaseError).toBeNull()
  })

  it("opens the db once to resolve contextual built-in enablement for plain chat", async () => {
    let opened = 0
    await makeAssembler({ ensureDb: async () => void (opened += 1) }).resolveSession()
    expect(opened).toBe(1)
  })

  it("falls back to the built-in subagents when discovery throws", async () => {
    const ctx = await makeAssembler({
      resolveAgents: async () => {
        throw new Error("scan failed")
      },
    }).resolveSession()
    expect(ctx.agents.length).toBeGreaterThan(0)
    expect(ctx.subagentToolEnabled).toBe(true)
  })

  it("keeps a bad agent mode from breaking the turn", async () => {
    const ctx = await makeAssembler({
      resolveAgentMode: async () => {
        throw new Error("bad mode json")
      },
    }).resolveSession()
    expect(ctx.sendOptions.systemPrompt).toBe("sys")
  })

  it("exposes the resolved roots and a context version that tracks them", async () => {
    const a = await makeAssembler(
      {},
      cfg({ additionalRoots: ["/work/x", "/work/x"] })
    ).resolveSession()
    expect(a.additionalDirectories).toEqual(["/work/x"])
    const b = await makeAssembler({}, cfg({ additionalRoots: ["/work/y"] })).resolveSession()
    expect(b.contextVersion).not.toBe(a.contextVersion)
  })

  it("carries the resolved MCP rows so an external transport can read them", async () => {
    const rows = [{ name: "alpha", enabled: true } as unknown as McpServer]
    const ctx = await makeAssembler({ resolveMcpServers: () => rows }).resolveSession()
    expect(ctx.mcpServers).toBe(rows)
  })
})

describe("createCliContextAssembler — turn context", () => {
  it("reports attachments only when the prompt referenced something", async () => {
    const withRefs = makeAssembler({
      buildContent: async () => ({
        content: "hi",
        imageCount: 1,
        documentCount: 0,
        injectedFiles: ["a.txt"],
        ocr: [],
        failed: [],
        skipped: [],
      }),
    })
    const session = await withRefs.resolveSession()
    expect((await withRefs.resolveTurn("hi @a.txt", session)).attachments).toEqual({
      imageCount: 1,
      documentCount: 0,
      injectedFiles: ["a.txt"],
      ocr: [],
      failed: [],
      skipped: [],
    })

    const plain = makeAssembler()
    const plainSession = await plain.resolveSession()
    expect((await plain.resolveTurn("hi", plainSession)).attachments).toBeNull()
  })

  it("emits the twin persona once and the dynamic recall every turn", async () => {
    const assembler = makeAssembler(
      {
        fetchTwin: async () => twin({ stable: "PERSONA", dynamic: "RECALL" }),
      },
      cfg({ twin: { enabled: true, characterId: "c1" } })
    )
    const session = await assembler.resolveSession()
    const first = await assembler.resolveTurn("one", session)
    expect(first.stableTwinContext).toBe("PERSONA")
    expect(first.dynamicTwinContext).toBe("RECALL")
    const second = await assembler.resolveTurn("two", session)
    expect(second.stableTwinContext).toBeUndefined()
    expect(second.dynamicTwinContext).toBe("RECALL")
  })

  it("re-emits the persona after invalidate (the rebuilt prompt lost it)", async () => {
    const assembler = makeAssembler(
      { fetchTwin: async () => twin({ stable: "PERSONA" }) },
      cfg({ twin: { enabled: true, characterId: "c1" } })
    )
    const session = await assembler.resolveSession()
    expect((await assembler.resolveTurn("one", session)).stableTwinContext).toBe("PERSONA")
    assembler.invalidate()
    const next = await assembler.resolveSession()
    expect((await assembler.resolveTurn("two", next)).stableTwinContext).toBe("PERSONA")
  })

  it("notices exactly once when the twin bridge is unreachable", async () => {
    const assembler = makeAssembler(
      { fetchTwin: async () => null },
      cfg({ twin: { enabled: true, characterId: "c1" } })
    )
    const session = await assembler.resolveSession()
    expect((await assembler.resolveTurn("one", session)).twinNotice).toMatch(/not reachable/)
    expect((await assembler.resolveTurn("two", session)).twinNotice).toBeUndefined()
  })

  it("never fetches the twin when grounding is off or unconfigured", async () => {
    let fetched = 0
    const off = makeAssembler({ fetchTwin: async () => void ++fetched as never })
    const session = await off.resolveSession()
    await off.resolveTurn("one", session)
    const unconfigured = makeAssembler(
      { fetchTwin: async () => void ++fetched as never },
      cfg({ twin: { enabled: true } })
    )
    await unconfigured.resolveTurn("one", await unconfigured.resolveSession())
    expect(fetched).toBe(0)
  })
})

describe("twin content helpers", () => {
  it("wraps recall in the shared envelope", () => {
    expect(twinContextBlock("R")).toBe("<twin-context>\nR\n</twin-context>")
  })

  it("prepends to a string prompt and to multimodal blocks alike", () => {
    expect(prependTextBlock("hi", "B")).toBe("B\n\nhi")
    expect(prependTextBlock([{ type: "image", source: {} }] as never, "B")).toEqual([
      { type: "text", text: "B" },
      { type: "image", source: {} },
    ])
  })

  it("returns the content untouched for an empty block", () => {
    expect(prependTextBlock("hi", "")).toBe("hi")
  })
})
