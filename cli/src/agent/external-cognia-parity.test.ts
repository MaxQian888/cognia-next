/**
 * @jest-environment node
 *
 * The parity contract: for one config, the external backend must resolve the
 * SAME Cognia session as the built-in backend, and must expose the same
 * Cognia-owned tool names. These tests compare the two paths directly rather
 * than asserting on the external path alone — a shared regression would then
 * pass both halves of a one-sided test.
 */
import type { SendOptions } from "@cognia/agent-config-types"
import { DEFAULT_BUILTIN_TOOLS } from "@cognia/agent-config-types"
import type {
  ExternalAgentExecutionOptions,
  ExternalAgentResult,
} from "@/types/agent/external-agent"
import { namespaced } from "@/lib/settings/builtin-tools"

import { DEFAULT_RESOLVED_CONFIG, type ResolvedConfig } from "../config/schema"
import {
  createExternalAgentSession,
  type ExternalAgentSessionManager,
} from "./external-agent-session"
import { createCliContextAssembler } from "./session-context"
import { visibleBuiltinTools, visibleHostTools } from "./tool-host/policy"
import type { ToolHostBroker } from "./tool-host/broker"
import type { ResolvedCliSessionContext } from "./session-context"
import type { TranscriptFs } from "./transcript"
import type { TuiAction } from "../tui/state/types"

const HOME = "/home/u/.cognia"

function cfg(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    ...DEFAULT_RESOLVED_CONFIG,
    builtinTools: { ...DEFAULT_BUILTIN_TOOLS, git: true, coreFiles: true },
    providers: { anthropic: { apiKey: "sk" } },
    cwd: "/work",
    agentBackend: "claude-code",
    ...overrides,
  }
}

const memoryFs = (): TranscriptFs => ({
  append: () => undefined,
  read: () => null,
  mkdirp: () => undefined,
  write: () => undefined,
})

/** The seams both backends share, so a comparison isolates the transport. */
function sharedSeams(config: ResolvedConfig, resolved: Partial<SendOptions> = {}) {
  return {
    config,
    sessionId: "s1",
    home: HOME,
    now: () => 1_700_000_000_000,
    resolveOptions: async () =>
      ({
        systemPrompt: "CANONICAL PROMPT",
        model: "resolved-model",
        builtinTools: config.builtinTools,
        confinement: { enabled: true, roots: [config.cwd] },
        pluginTools: [
          { name: "ask_user", description: "ask", jsonSchema: {}, pluginId: "core" },
          { name: "web_search", description: "search", jsonSchema: {}, pluginId: "web" },
        ],
        ...resolved,
      }) as SendOptions,
    buildContent: (prompt: string) => ({
      content: prompt,
      imageCount: 0,
      documentCount: 0,
      injectedFiles: [],
      ocr: [],
      failed: [],
      skipped: [],
    }),
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
  }
}

/** A broker double: records the session it was started with, opens no socket. */
function fakeToolHost() {
  const started: { session: ResolvedCliSessionContext; attempt: number }[] = []
  let closes = 0
  const broker = {
    endpoint: "/tmp/fake.sock",
    token: "fake-token",
    attempt: 1,
    connections: () => 0,
    isClosed: () => false,
    cancelInFlight: () => undefined,
    close: async () => {
      closes += 1
    },
  } as unknown as ToolHostBroker
  return {
    started,
    closes: () => closes,
    start: async (p: { session: ResolvedCliSessionContext; attempt: number }) => {
      started.push({ session: p.session, attempt: p.attempt })
      return broker
    },
  }
}

function fakeManager(result?: Partial<ExternalAgentResult>) {
  let executeOptions: ExternalAgentExecutionOptions | undefined
  let prompt = ""
  const manager: ExternalAgentSessionManager = {
    addAgent: jest.fn(async () => undefined),
    execute: jest.fn(async (_agentId, sent, options) => {
      executeOptions = options
      prompt = sent
      options?.onEvent?.({ type: "done", timestamp: new Date(), success: true })
      return {
        success: true,
        sessionId: "acp-1",
        finalResponse: "ok",
        messages: [],
        steps: [],
        toolCalls: [],
        duration: 1,
        ...result,
      } as ExternalAgentResult
    }),
    setSessionMode: jest.fn(async () => undefined),
    setSessionModel: jest.fn(async () => undefined),
    cancel: jest.fn(async () => undefined),
    removeAgent: jest.fn(async () => undefined),
  }
  return { manager, options: () => executeOptions, prompt: () => prompt }
}

function externalSession(
  config: ResolvedConfig,
  extra: Partial<Parameters<typeof createExternalAgentSession>[0]> = {},
  resolved: Partial<SendOptions> = {}
) {
  const { manager, options, prompt } = fakeManager()
  const host = fakeToolHost()
  const actions: TuiAction[] = []
  const session = createExternalAgentSession({
    config,
    manager,
    home: HOME,
    sessionId: "s1",
    transcriptFs: memoryFs(),
    assembler: createCliContextAssembler(sharedSeams(config, resolved)),
    startToolHost: host.start as never,
    buildToolHostServers: () =>
      [
        { name: "cognia-tools", command: "node", args: ["bridge"], env: [] },
        { name: "cognia-plugin-tools", command: "node", args: ["bridge"], env: [] },
      ] as never,
    ...extra,
  })
  return { session, manager, options, prompt, host, actions }
}

const gate = async () => ({ decision: "allow" as const })

describe("canonical context parity", () => {
  it("sends the resolved Cognia prompt, not the raw config systemPrompt", async () => {
    const config = cfg({ systemPrompt: "RAW CONFIG PROMPT" })
    const { session, options } = externalSession(config)
    await session.send("hi", { gate })
    expect(options()?.systemPrompt).toBe("CANONICAL PROMPT")
  })

  it("resolves the same session context the built-in backend would", async () => {
    const config = cfg({ additionalRoots: ["/work/pkg"] })
    const builtin = await createCliContextAssembler(sharedSeams(config)).resolveSession()
    const { session, options } = externalSession(config)
    await session.send("hi", { gate })
    expect(options()?.workingDirectory).toBe(builtin.cwd)
    expect(options()?.context?.custom?.additionalDirectories).toEqual(builtin.additionalDirectories)
    expect(options()?.systemPrompt).toBe(builtin.sendOptions.systemPrompt)
    expect(options()?.instructionEnvelope?.hash).toBe(builtin.contextVersion)
  })

  it("advertises exactly the built-in backend's effective Cognia tool names", async () => {
    const config = cfg()
    const builtin = await createCliContextAssembler(sharedSeams(config)).resolveSession()
    const { session, host } = externalSession(config)
    await session.send("hi", { gate })
    const hosted = host.started[0].session
    expect(visibleBuiltinTools(hosted.sendOptions)).toEqual(
      visibleBuiltinTools(builtin.sendOptions)
    )
    expect(visibleHostTools(hosted.sendOptions)).toEqual(visibleHostTools(builtin.sendOptions))
  })

  it("keeps a disabled category out of the hosted surface entirely", async () => {
    const config = cfg({ builtinTools: { ...DEFAULT_BUILTIN_TOOLS, git: false, coreFiles: true } })
    const { session, host } = externalSession(config)
    await session.send("hi", { gate })
    expect(visibleBuiltinTools(host.started[0].session.sendOptions)).not.toContain("git_status")
  })

  it("hides mutating tools under plan mode", async () => {
    const { session, host } = externalSession(cfg(), {}, { permissionMode: "plan" })
    await session.send("hi", { gate })
    const visible = visibleBuiltinTools(host.started[0].session.sendOptions)
    expect(visible).not.toContain("write")
    expect(visible).not.toContain("bash")
  })

  it("honours an allowlist as exhaustive on the external path too", async () => {
    const { session, host } = externalSession(
      cfg(),
      {},
      { allowedTools: [namespaced("git_status")] }
    )
    await session.send("hi", { gate })
    expect(visibleBuiltinTools(host.started[0].session.sendOptions)).toEqual(["git_status"])
  })
})

describe("Cognia tool projection", () => {
  it("attaches BOTH Cognia namespaces alongside the user's MCP servers", async () => {
    const { session, options } = externalSession(cfg())
    await session.send("hi", { gate })
    expect(
      (options()?.context?.custom?.mcpServers as { name: string }[]).map((s) => s.name)
    ).toEqual(["cognia-tools", "cognia-plugin-tools"])
  })

  it("starts the host exactly once across turns on a stable context", async () => {
    const { session, host } = externalSession(cfg())
    await session.send("one", { gate })
    await session.send("two", { gate })
    expect(host.started).toHaveLength(1)
  })

  it("fails the turn — loudly — when the Cognia tool host cannot start", async () => {
    const { session } = externalSession(cfg(), {
      startToolHost: async () => {
        throw new Error("socket refused")
      },
    })
    await expect(session.send("hi", { gate })).rejects.toThrow(
      /could not host its tools for claude-code: socket refused/
    )
  })

  it("attaches nothing when the raw (non-parity) escape hatch is selected", async () => {
    const { session, options, host } = externalSession(cfg(), { disableToolHost: true })
    await session.send("hi", { gate })
    expect(host.started).toHaveLength(0)
    expect(options()?.context?.custom?.mcpServers).toEqual([])
  })

  it("reports the tool surface it actually attached in the instruction envelope", async () => {
    const { session, options } = externalSession(cfg())
    await session.send("hi", { gate })
    expect(options()?.instructionEnvelope?.sourceFlags).toMatchObject({ hasCogniaTools: true })
  })
})

describe("permission choreography", () => {
  it("auto-acknowledges the agent's ask for a Cognia-projected tool (no second prompt)", async () => {
    const { manager, options } = fakeManager()
    let prompts = 0
    const config = cfg()
    const host = fakeToolHost()
    const session = createExternalAgentSession({
      config,
      manager,
      home: HOME,
      sessionId: "s1",
      transcriptFs: memoryFs(),
      assembler: createCliContextAssembler(sharedSeams(config)),
      startToolHost: host.start as never,
      buildToolHostServers: () => [] as never,
    })
    manager.execute = jest.fn(async (_id, _prompt, opts) => {
      const response = await opts?.onPermissionRequest?.({
        id: "p1",
        toolInfo: { id: "t", name: "mcp__cognia-tools__write" },
        rawInput: {},
      } as never)
      expect(response).toMatchObject({ granted: true })
      return {
        success: true,
        sessionId: "acp-1",
        finalResponse: "ok",
        messages: [],
        steps: [],
        toolCalls: [],
        duration: 1,
      } as ExternalAgentResult
    })
    await session.send("hi", {
      gate: async () => {
        prompts += 1
        return { decision: "allow" }
      },
    })
    expect(prompts).toBe(0)
    expect(options).toBeDefined()
  })

  it("still routes the agent's NATIVE tool asks through Cognia's overlay", async () => {
    const { manager } = fakeManager()
    const asked: string[] = []
    const config = cfg()
    const host = fakeToolHost()
    const session = createExternalAgentSession({
      config,
      manager,
      home: HOME,
      sessionId: "s1",
      transcriptFs: memoryFs(),
      assembler: createCliContextAssembler(sharedSeams(config)),
      startToolHost: host.start as never,
      buildToolHostServers: () => [] as never,
    })
    manager.execute = jest.fn(async (_id, _prompt, opts) => {
      await opts?.onPermissionRequest?.({
        id: "p1",
        toolInfo: { id: "t", name: "Edit" },
        rawInput: { path: "a.ts" },
      } as never)
      return {
        success: true,
        sessionId: "acp-1",
        finalResponse: "ok",
        messages: [],
        steps: [],
        toolCalls: [],
        duration: 1,
      } as ExternalAgentResult
    })
    await session.send("hi", {
      gate: async (req) => {
        asked.push(req.toolName)
        return { decision: "allow" }
      },
    })
    expect(asked).toEqual(["Edit"])
  })
})

describe("turn content", () => {
  it("folds the twin persona and per-turn recall into the prompt", async () => {
    const config = cfg({ twin: { enabled: true, characterId: "c1" } })
    const { manager, prompt } = fakeManager()
    const host = fakeToolHost()
    const session = createExternalAgentSession({
      config,
      manager,
      home: HOME,
      sessionId: "s1",
      transcriptFs: memoryFs(),
      assembler: createCliContextAssembler({
        ...sharedSeams(config),
        fetchTwin: async () => ({
          ok: true,
          applied: { systemPrompt: "PERSONA", stable: "PERSONA", dynamic: "RECALL" },
          degraded: false,
          sources: [],
          styleSampleCount: 0,
        }),
      }),
      startToolHost: host.start as never,
      buildToolHostServers: () => [] as never,
    })
    await session.send("question", { gate })
    expect(prompt()).toContain("<twin-context>\nPERSONA\n</twin-context>")
    expect(prompt()).toContain("<twin-context>\nRECALL\n</twin-context>")
    expect(prompt()).toContain("question")
  })

  it("refuses to send a turn whose attachment could not be reduced to text", async () => {
    const config = cfg()
    const { manager } = fakeManager()
    const host = fakeToolHost()
    const session = createExternalAgentSession({
      config,
      manager,
      home: HOME,
      sessionId: "s1",
      transcriptFs: memoryFs(),
      assembler: createCliContextAssembler({
        ...sharedSeams(config),
        buildContent: () => ({
          content: [
            { type: "text", text: "look" },
            { type: "image", source: { type: "base64", data: "x", media_type: "image/png" } },
          ] as never,
          imageCount: 1,
          documentCount: 0,
          injectedFiles: [],
          ocr: [],
          failed: [],
          skipped: [],
        }),
      }),
      startToolHost: host.start as never,
      buildToolHostServers: () => [] as never,
    })
    await expect(session.send("look @a.png", { gate })).rejects.toThrow(
      /cannot carry image attachments/
    )
    expect(manager.execute).not.toHaveBeenCalled()
  })

  it("reports attachments and active skills through the shared callbacks", async () => {
    const config = cfg()
    const { manager } = fakeManager()
    const host = fakeToolHost()
    const skills: string[][] = []
    const session = createExternalAgentSession({
      config,
      manager,
      home: HOME,
      sessionId: "s1",
      transcriptFs: memoryFs(),
      assembler: createCliContextAssembler({
        ...sharedSeams(config),
        resolveSkillIds: () => ["skill-a"],
      }),
      startToolHost: host.start as never,
      buildToolHostServers: () => [] as never,
    })
    await session.send("hi", { gate, onActiveSkills: (ids) => skills.push(ids) })
    expect(skills).toEqual([["skill-a"]])
  })
})

describe("tool-host rendering", () => {
  /** A broker double that drives the render callbacks it is handed. */
  function renderingHost() {
    let captured: {
      onToolCall?: (e: { name: string; input: unknown; callKey: string }) => void
      onToolResult?: (e: { callKey: string; name: string; ok: boolean; summary?: string }) => void
    } = {}
    return {
      fire: () => {
        captured.onToolCall?.({ name: "read", input: { path: "a.ts" }, callKey: "k1" })
        captured.onToolResult?.({ callKey: "k1", name: "read", ok: true, summary: "42 lines" })
        captured.onToolResult?.({ callKey: "k2", name: "write", ok: false, summary: "denied" })
      },
      start: async (p: typeof captured) => {
        captured = p
        return {
          endpoint: "/tmp/x.sock",
          token: "t",
          attempt: 1,
          connections: () => 1,
          isClosed: () => false,
          cancelInFlight: () => undefined,
          close: async () => undefined,
        } as unknown as ToolHostBroker
      },
    }
  }

  it("renders a projected tool call and its result as ordinary tool cells", async () => {
    const config = cfg()
    const { manager } = fakeManager()
    const host = renderingHost()
    const actions: TuiAction[] = []
    const session = createExternalAgentSession({
      config,
      manager,
      home: HOME,
      sessionId: "s1",
      transcriptFs: memoryFs(),
      assembler: createCliContextAssembler(sharedSeams(config)),
      startToolHost: host.start as never,
      buildToolHostServers: () => [] as never,
    })
    await session.send("hi", { gate, onAction: (a) => actions.push(a) })
    host.fire()
    expect(actions.filter((a) => a.type === "TOOL_CALL")).toEqual([
      { type: "TOOL_CALL", callKey: "k1", toolName: "read", input: { path: "a.ts" } },
    ])
    expect(actions.filter((a) => a.type === "TOOL_RESULT")).toEqual([
      { type: "TOOL_RESULT", callKey: "k1", toolName: "read", result: "42 lines" },
      { type: "TOOL_RESULT", callKey: "k2", toolName: "write", result: "denied", isError: true },
    ])
  })

  it("builds attachments through the default (vision-off) content builder", async () => {
    // No `assembler` override, so the session's own builder — and its Anthropic
    // key closure — is exercised.
    const { manager, prompt } = fakeManager()
    const host = renderingHost()
    const session = createExternalAgentSession({
      config: cfg({ providers: {} }),
      manager,
      home: HOME,
      sessionId: "s1",
      transcriptFs: memoryFs(),
      startToolHost: host.start as never,
      buildToolHostServers: () => [] as never,
    })
    await session.send("plain question with no attachments", { gate })
    expect(prompt()).toContain("plain question with no attachments")
  })

  it("reports a twin outage and an attachment summary through the shared callbacks", async () => {
    const config = cfg({ twin: { enabled: true, characterId: "c1" } })
    const { manager } = fakeManager()
    const host = renderingHost()
    const notices: string[] = []
    const attachments: unknown[] = []
    const session = createExternalAgentSession({
      config,
      manager,
      home: HOME,
      sessionId: "s1",
      transcriptFs: memoryFs(),
      assembler: createCliContextAssembler({
        ...sharedSeams(config),
        fetchTwin: async () => null,
        buildContent: (p: string) => ({
          content: p,
          imageCount: 0,
          documentCount: 0,
          injectedFiles: ["a.txt"],
          ocr: [],
          failed: [],
          skipped: [],
        }),
      }),
      startToolHost: host.start as never,
      buildToolHostServers: () => [] as never,
    })
    await session.send("hi @a.txt", {
      gate,
      onTwinNotice: (m) => notices.push(m),
      onAttachments: (s) => attachments.push(s),
    })
    expect(notices[0]).toMatch(/not reachable/)
    expect(attachments).toHaveLength(1)
  })

  it("cancels in-flight broker calls when the stream goes idle", async () => {
    const config = cfg({ streamIdleTimeoutMs: 5 })
    const cancels: string[] = []
    const manager: ExternalAgentSessionManager = {
      addAgent: jest.fn(async () => undefined),
      // Emits one event and then never settles, so the idle watchdog fires.
      execute: jest.fn((_id, _prompt, options) => {
        options?.onEvent?.({
          type: "message_delta",
          sessionId: "acp-1",
          timestamp: new Date(),
          delta: { type: "text", text: "working" },
        })
        return new Promise<ExternalAgentResult>(() => {})
      }),
      setSessionMode: jest.fn(async () => undefined),
      setSessionModel: jest.fn(async () => undefined),
      cancel: jest.fn(async () => undefined),
      removeAgent: jest.fn(async () => undefined),
    }
    const session = createExternalAgentSession({
      config,
      manager,
      home: HOME,
      sessionId: "s1",
      transcriptFs: memoryFs(),
      assembler: createCliContextAssembler(sharedSeams(config)),
      startToolHost: async () =>
        ({
          endpoint: "/tmp/x.sock",
          token: "t",
          attempt: 1,
          connections: () => 0,
          isClosed: () => false,
          cancelInFlight: (reason: string) => cancels.push(reason),
          close: async () => undefined,
        }) as unknown as ToolHostBroker,
      buildToolHostServers: () => [] as never,
    })
    await expect(session.send("hi", { gate })).rejects.toThrow(/stream idle/)
    expect(cancels).toEqual(["the turn was interrupted"])
  })
})
