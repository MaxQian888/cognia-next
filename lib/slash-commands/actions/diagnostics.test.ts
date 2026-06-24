jest.mock("@/lib/claude/ipc", () => ({
  getSidecarStatus: jest.fn(),
  hasApiKey: jest.fn(),
  hasOauthBearer: jest.fn(),
  compactSession: jest.fn(),
}))
jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(() => false),
}))
jest.mock("@/lib/db/sessions", () => ({
  getSession: jest.fn(),
}))
jest.mock("@/lib/db/mcp-servers", () => ({
  listEnabledMcpServers: jest.fn(),
}))
jest.mock("@/lib/claude/build-options", () => ({
  resolveSendOptions: jest.fn(),
}))
jest.mock("@/stores/chat", () => ({
  useChatStore: { getState: jest.fn() },
}))
jest.mock("@/stores/settings", () => ({
  useSettingsStore: { getState: jest.fn() },
}))
jest.mock("@/lib/native/crash-reports", () => ({
  getCrashLoggingDiagnostics: jest.fn(async () => null),
}))
jest.mock("@/lib/native/native-logging", () => ({
  getNativeLoggingReadiness: jest.fn(async () => null),
}))

import { handleStatus, handleCost, handleContext, handleDoctor, handleCompact } from "./diagnostics"
import { getCrashLoggingDiagnostics } from "@/lib/native/crash-reports"
import { getNativeLoggingReadiness } from "@/lib/native/native-logging"
import { getSidecarStatus, hasApiKey, hasOauthBearer, compactSession } from "@/lib/claude/ipc"
import { isTauri } from "@/lib/tauri"
import { getSession } from "@/lib/db/sessions"
import { listEnabledMcpServers } from "@/lib/db/mcp-servers"
import { resolveSendOptions } from "@/lib/claude/build-options"
import { useChatStore } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"
import type { SlashContext } from "../builtin"

const mockedSidecar = getSidecarStatus as unknown as jest.Mock
const mockedHasApiKey = hasApiKey as unknown as jest.Mock
const mockedHasOauthBearer = hasOauthBearer as unknown as jest.Mock
const mockedIsTauri = isTauri as unknown as jest.Mock
const mockedGetSession = getSession as unknown as jest.Mock
const mockedMcp = listEnabledMcpServers as unknown as jest.Mock
const mockedResolve = resolveSendOptions as unknown as jest.Mock
const mockedChatGetState = useChatStore.getState as unknown as jest.Mock
const mockedSettingsGetState = useSettingsStore.getState as unknown as jest.Mock
const mockedCompact = compactSession as unknown as jest.Mock

type Pushed = Parameters<SlashContext["pushSystemMessage"]>[0]

function makeCtx(overrides: Partial<SlashContext> = {}): SlashContext & { _pushed: Pushed[] } {
  const pushed: Pushed[] = []
  return {
    args: "",
    activeSessionId: null,
    chatStatus: "ready",
    currentPermissionMode: null,
    startNewSession: () => undefined,
    openSettings: () => undefined,
    setPermissionMode: () => undefined,
    pushSystemMessage: (payload: Pushed) => {
      pushed.push(payload)
    },
    _pushed: pushed,
    ...overrides,
  } as SlashContext & { _pushed: Pushed[] }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockedChatGetState.mockReturnValue({ messages: [], referencedPaths: [] })
  mockedSettingsGetState.mockReturnValue({ settings: null })
  mockedHasOauthBearer.mockResolvedValue(false)
  mockedIsTauri.mockReturnValue(false)
})

describe("handleStatus", () => {
  it("reports no active session and runtime info", async () => {
    mockedSidecar.mockResolvedValue({ ready: true })
    mockedHasApiKey.mockResolvedValue(true)
    mockedMcp.mockResolvedValue([])
    const ctx = makeCtx({ activeSessionId: null })
    await handleStatus(ctx)
    const md = ctx._pushed[0]
    expect(md).toContain("**Status**")
    expect(md).toContain("No active session.")
    expect(md).toContain("Sidecar: ready")
    expect(md).toContain("API key: set")
    expect(md).toContain("MCP servers enabled: 0")
  })

  it("renders effective send options for an active session", async () => {
    mockedSidecar.mockResolvedValue({ ready: false })
    mockedHasApiKey.mockResolvedValue(false)
    mockedMcp.mockResolvedValue([{ name: "fs" }, { name: "git" }])
    mockedGetSession.mockResolvedValue({
      id: "s",
      title: "Demo",
      sdkSessionId: "0123456789ABCDEF",
    })
    mockedResolve.mockResolvedValue({
      model: "claude-3",
      permissionMode: "default",
      cwd: "/work",
      additionalDirectories: ["/d"],
      allowedTools: ["bash"],
    })
    const ctx = makeCtx({ activeSessionId: "s", currentPermissionMode: "plan" })
    await handleStatus(ctx)
    const md = ctx._pushed[0]
    expect(md).toContain("Demo")
    expect(md).toContain("claude-3")
    expect(md).toContain("default")
    expect(md).toContain("(overridden by composer)")
    expect(md).toContain("/work")
    expect(md).toContain("Additional dirs**: 1")
    expect(md).toContain("Allowed tools**: 1")
    expect(md).toContain("0123456789AB")
    expect(md).toContain("Sidecar: not ready")
    expect(md).toContain("API key: not set")
    expect(md).toContain("MCP servers enabled: 2")
    expect(md).toContain("(fs, git)")
  })

  it("renders fallback text for an unknown title and SDK default model", async () => {
    mockedSidecar.mockResolvedValue({ ready: true })
    mockedHasApiKey.mockResolvedValue(true)
    mockedMcp.mockResolvedValue([])
    mockedGetSession.mockResolvedValue(null)
    mockedResolve.mockResolvedValue({})
    const ctx = makeCtx({ activeSessionId: "missing" })
    await handleStatus(ctx)
    const md = ctx._pushed[0]
    expect(md).toContain("(unknown)")
    expect(md).toContain("(SDK default)")
    expect(md).toContain("(default)")
  })

  it("captures resolveSendOptions errors gracefully", async () => {
    mockedSidecar.mockResolvedValue({ ready: true })
    mockedHasApiKey.mockResolvedValue(true)
    mockedMcp.mockResolvedValue([])
    mockedGetSession.mockResolvedValue({ id: "s", title: "T" })
    mockedResolve.mockRejectedValue(new Error("explode"))
    const ctx = makeCtx({ activeSessionId: "s" })
    await handleStatus(ctx)
    expect(ctx._pushed[0]).toContain("Could not resolve session config: explode")
  })

  it("captures non-Error rejection from resolveSendOptions", async () => {
    mockedSidecar.mockResolvedValue({ ready: true })
    mockedHasApiKey.mockResolvedValue(true)
    mockedMcp.mockResolvedValue([])
    mockedGetSession.mockResolvedValue({ id: "s", title: "T" })
    mockedResolve.mockRejectedValue("plain")
    const ctx = makeCtx({ activeSessionId: "s" })
    await handleStatus(ctx)
    expect(ctx._pushed[0]).toContain("Could not resolve session config: plain")
  })

  it("tolerates failures from sidecar/api/mcp probes", async () => {
    mockedSidecar.mockRejectedValue(new Error("sb"))
    mockedHasApiKey.mockRejectedValue(new Error("ak"))
    mockedMcp.mockRejectedValue(new Error("mcp"))
    const ctx = makeCtx()
    await handleStatus(ctx)
    expect(ctx._pushed[0]).toContain("Sidecar: not ready")
    expect(ctx._pushed[0]).toContain("API key: not set")
    expect(ctx._pushed[0]).toContain("MCP servers enabled: 0")
  })
})

describe("handleCost", () => {
  it("rejects when there is no active session", async () => {
    const ctx = makeCtx({ activeSessionId: null })
    await handleCost(ctx)
    expect(ctx._pushed[0]).toBe("No active session.")
  })

  it("reports no assistant turns when the message list lacks any", async () => {
    mockedChatGetState.mockReturnValue({ messages: [{ role: "user" }] })
    const ctx = makeCtx({ activeSessionId: "s" })
    await handleCost(ctx)
    expect(ctx._pushed[0]).toContain("No assistant turns yet")
  })

  it("notes no metrics when assistant turns lack usage payloads", async () => {
    mockedChatGetState.mockReturnValue({
      messages: [{ role: "assistant" }, { role: "assistant", metadata: {} }],
    })
    const ctx = makeCtx({ activeSessionId: "s" })
    await handleCost(ctx)
    expect(ctx._pushed[0]).toContain("No usage metrics recorded yet")
  })

  it("aggregates token / cost / cache / duration totals", async () => {
    mockedChatGetState.mockReturnValue({
      messages: [
        {
          role: "assistant",
          metadata: {
            usage: {
              inputTokens: 1000,
              outputTokens: 2000,
              cacheCreationInputTokens: 300,
              cacheReadInputTokens: 100,
              totalCostUsd: 0.05,
              durationMs: 1500,
            },
          },
        },
        {
          role: "assistant",
          metadata: {
            usage: {
              inputTokens: 500,
            },
          },
        },
      ],
    })
    const ctx = makeCtx({ activeSessionId: "s" })
    await handleCost(ctx)
    const block = ctx._pushed[0] as Extract<Pushed, { kind: "cost" }>
    expect(block.kind).toBe("cost")
    expect(block.assistantTurns).toBe(2)
    expect(block.metricTurns).toBe(2)
    expect(block.inputTokens).toBe(1500)
    expect(block.outputTokens).toBe(2000)
    expect(block.cacheCreateTokens).toBe(300)
    expect(block.cacheReadTokens).toBe(100)
    expect(block.costUsd).toBeCloseTo(0.05)
    expect(block.costEstimated).toBe(false)
    expect(block.durationMs).toBe(1500)
    // Window occupancy is the LATEST turn (inputTokens 500), not the sum.
    expect(block.window?.used).toBe(500)
    expect(block.window?.max).toBe(200_000)
  })

  it("omits cache/cost/duration when zero", async () => {
    mockedChatGetState.mockReturnValue({
      messages: [
        {
          role: "assistant",
          metadata: { usage: { inputTokens: 1, outputTokens: 1 } },
        },
      ],
    })
    const ctx = makeCtx({ activeSessionId: "s" })
    await handleCost(ctx)
    const block = ctx._pushed[0] as Extract<Pushed, { kind: "cost" }>
    expect(block.inputTokens).toBe(1)
    expect(block.cacheCreateTokens).toBe(0)
    expect(block.cacheReadTokens).toBe(0)
    expect(block.costUsd).toBeNull()
    expect(block.durationMs).toBe(0)
  })

  it("estimates cost from pricing when the SDK reported none (non-Anthropic)", async () => {
    // gpt-4o is priced; the ai-sdk path carries no totalCostUsd, so /cost would
    // otherwise be blank. The estimate is surfaced and flagged "(estimated)".
    mockedGetSession.mockResolvedValue({ id: "s", model: "gpt-4o", providerOverride: "openai" })
    mockedChatGetState.mockReturnValue({
      messages: [
        { role: "assistant", metadata: { usage: { inputTokens: 10_000, outputTokens: 5_000 } } },
      ],
    })
    const ctx = makeCtx({ activeSessionId: "s" })
    await handleCost(ctx)
    const block = ctx._pushed[0] as Extract<Pushed, { kind: "cost" }>
    expect(block.costUsd).toBeGreaterThan(0)
    expect(block.costEstimated).toBe(true)
  })

  it("sizes the window from a custom model's declared context length", async () => {
    mockedGetSession.mockResolvedValue({ id: "s", model: "big", providerOverride: "cp" })
    mockedSettingsGetState.mockReturnValue({
      settings: {
        customProviders: [
          { id: "cp", customModelMetadata: { big: { id: "big", contextLength: 500_000 } } },
        ],
      },
    })
    mockedChatGetState.mockReturnValue({
      messages: [{ role: "assistant", metadata: { usage: { inputTokens: 100 } } }],
    })
    const ctx = makeCtx({ activeSessionId: "s" })
    await handleCost(ctx)
    const block = ctx._pushed[0] as Extract<Pushed, { kind: "cost" }>
    expect(block.window?.used).toBe(100)
    expect(block.window?.max).toBe(500_000)
  })
})

describe("handleDoctor", () => {
  it("reports OAuth path when bearer present", async () => {
    mockedSidecar.mockResolvedValue({ ready: true })
    mockedHasApiKey.mockResolvedValue(false)
    mockedHasOauthBearer.mockResolvedValue(true)
    mockedMcp.mockResolvedValue([{ name: "fs", transport: "stdio" }])
    mockedSettingsGetState.mockReturnValue({
      settings: {
        defaultModel: "claude-3",
        permissionMode: "acceptEdits",
        defaultWorkingDir: "/work",
        defaultMaxThinkingTokens: 8000,
      },
    })
    mockedIsTauri.mockReturnValue(true)
    const ctx = makeCtx()
    await handleDoctor(ctx)
    const md = ctx._pushed[0]
    expect(md).toContain("**Doctor**")
    expect(md).toContain("Mode: Tauri desktop")
    expect(md).toContain("Sidecar: ready")
    expect(md).toContain("Claude OAuth bearer: present")
    expect(md).toContain("Default model: claude-3")
    expect(md).toContain("Permission mode: acceptEdits")
    expect(md).toContain("Working dir: /work")
    expect(md).toContain("Thinking budget: 8000 tokens")
    expect(md).toContain("`fs` (stdio)")
    expect(md).toContain("Settings → Agent runtime → Sidecar")
    expect(md).toContain("**Crash & Logs**")
    expect(md).toContain("Global error capture: ready")
  })

  it("surfaces crash + native-logging diagnostics when available", async () => {
    mockedSidecar.mockResolvedValue({ ready: true })
    mockedHasOauthBearer.mockResolvedValue(true)
    mockedMcp.mockResolvedValue([])
    mockedSettingsGetState.mockReturnValue({ settings: null })
    mockedIsTauri.mockReturnValue(true)
    ;(getCrashLoggingDiagnostics as jest.Mock).mockResolvedValueOnce({
      crashReportCount: 3,
      latestCrashAt: "2026-06-10T00:00:00Z",
      retentionMaxAgeDays: 30,
      retentionMaxReports: 50,
      rotatedLogKeep: 5,
    })
    ;(getNativeLoggingReadiness as jest.Mock).mockResolvedValueOnce({
      startupMode: "full",
      startupHealth: "healthy",
    })
    const ctx = makeCtx()
    await handleDoctor(ctx)
    const md = ctx._pushed[0]
    expect(md).toContain("Crash reports: 3")
    expect(md).toContain("Last crash: 2026-06-10T00:00:00Z")
    expect(md).toContain("Retention: 30d / 50 reports, keep 5 logs")
    expect(md).toContain("Native logging: full / healthy")
  })

  it("reports API key path + web mode when no OAuth", async () => {
    mockedSidecar.mockResolvedValue({ ready: false })
    mockedHasApiKey.mockResolvedValue(true)
    mockedHasOauthBearer.mockResolvedValue(false)
    mockedMcp.mockResolvedValue([])
    mockedSettingsGetState.mockReturnValue({ settings: null })
    mockedIsTauri.mockReturnValue(false)
    const ctx = makeCtx()
    await handleDoctor(ctx)
    const md = ctx._pushed[0]
    expect(md).toContain("Mode: Web (browser)")
    expect(md).toContain("Sidecar: not ready")
    expect(md).toContain("Anthropic API key: present")
    expect(md).toContain("Default model: (SDK default)")
    expect(md).toContain("Permission mode: default")
    expect(md).toContain("Working dir: (none)")
    expect(md).toContain("Thinking budget: disabled")
    expect(md).toContain("No enabled MCP servers.")
    expect(md).toContain("require the desktop build")
  })

  it("warns when neither credential is present", async () => {
    mockedSidecar.mockResolvedValue({ ready: true })
    mockedHasApiKey.mockResolvedValue(false)
    mockedHasOauthBearer.mockResolvedValue(false)
    mockedMcp.mockResolvedValue([])
    const ctx = makeCtx()
    await handleDoctor(ctx)
    expect(ctx._pushed[0]).toContain("⚠ No credentials")
  })

  it("tolerates probe failures", async () => {
    mockedSidecar.mockRejectedValue(new Error("fail"))
    mockedHasApiKey.mockRejectedValue(new Error("fail"))
    mockedHasOauthBearer.mockRejectedValue(new Error("fail"))
    mockedMcp.mockRejectedValue(new Error("fail"))
    const ctx = makeCtx()
    await handleDoctor(ctx)
    expect(ctx._pushed[0]).toContain("Sidecar: not ready")
    expect(ctx._pushed[0]).toContain("⚠ No credentials")
  })
})

describe("handleContext", () => {
  it("reports a fresh window when there are no assistant turns", async () => {
    mockedChatGetState.mockReturnValue({ messages: [{ role: "user" }] })
    const ctx = makeCtx()
    await handleContext(ctx)
    const block = ctx._pushed[0] as Extract<Pushed, { kind: "context" }>
    expect(block.kind).toBe("context")
    expect(block.userTurns).toBe(1)
    expect(block.assistantTurns).toBe(0)
    expect(block.window).toBeUndefined()
    expect(block.tokens).toBeUndefined()
  })

  it("aggregates input/output/cache totals across assistant turns", async () => {
    mockedChatGetState.mockReturnValue({
      messages: [
        { role: "user" },
        {
          role: "assistant",
          metadata: {
            usage: {
              inputTokens: 1000,
              outputTokens: 500,
              cacheCreationInputTokens: 200,
              cacheReadInputTokens: 100,
            },
          },
        },
        {
          role: "assistant",
          metadata: { usage: { inputTokens: 200, outputTokens: 300 } },
        },
      ],
    })
    const ctx = makeCtx()
    await handleContext(ctx)
    const block = ctx._pushed[0] as Extract<Pushed, { kind: "context" }>
    expect(block.userTurns).toBe(1)
    expect(block.assistantTurns).toBe(2)
    // Raw tallies; the card sums input + cache for the "incl. cache" display.
    expect(block.tokens).toEqual({ input: 1200, output: 800, cacheRead: 100, cacheCreate: 200 })
    // Window line uses the latest turn (200 in + 300 out = 500) vs the 200k default.
    expect(block.window?.used).toBe(500)
    expect(block.window?.max).toBe(200_000)
    expect(block.window?.remaining).toBe(199_500)
    expect(block.window?.autoCompactFraction).toBeCloseTo(0.835)
  })

  it("sizes the window from the active session's model", async () => {
    mockedChatGetState.mockReturnValue({
      messages: [{ role: "assistant", metadata: { usage: { inputTokens: 500_000 } } }],
    })
    mockedGetSession.mockResolvedValue({ id: "s", model: "claude-opus-4-8" })
    const ctx = makeCtx({ activeSessionId: "s" })
    await handleContext(ctx)
    const block = ctx._pushed[0] as Extract<Pushed, { kind: "context" }>
    // Opus 4.8 is the 1M tier → 500k / 1M = 50%.
    expect(block.window?.max).toBe(1_000_000)
    expect(block.window?.fraction).toBeCloseTo(0.5)
  })

  it("falls back to the app default model when the session lookup fails", async () => {
    mockedChatGetState.mockReturnValue({
      messages: [{ role: "assistant", metadata: { usage: { inputTokens: 100 } } }],
    })
    mockedGetSession.mockRejectedValue(new Error("nope"))
    mockedSettingsGetState.mockReturnValue({ settings: { defaultModel: "claude-sonnet-4-5" } })
    const ctx = makeCtx({ activeSessionId: "s" })
    await handleContext(ctx)
    const block = ctx._pushed[0] as Extract<Pushed, { kind: "context" }>
    expect(block.window?.max).toBe(200_000)
  })

  it("omits the cache line when no cache hits", async () => {
    mockedChatGetState.mockReturnValue({
      messages: [
        {
          role: "assistant",
          metadata: { usage: { inputTokens: 10, outputTokens: 5 } },
        },
      ],
    })
    const ctx = makeCtx()
    await handleContext(ctx)
    const block = ctx._pushed[0] as Extract<Pushed, { kind: "context" }>
    expect(block.tokens?.input).toBe(10)
    expect(block.tokens?.cacheRead).toBe(0)
    expect(block.tokens?.cacheCreate).toBe(0)
  })

  it("honors a discovered model's declared context length over the 200k default", async () => {
    mockedGetSession.mockResolvedValue({ id: "s", model: "acme-xl", providerOverride: "openai" })
    mockedSettingsGetState.mockReturnValue({
      settings: {
        providerSettings: {
          openai: { discoveredModels: [{ id: "acme-xl", contextLength: 400_000 }] },
        },
      },
    })
    mockedChatGetState.mockReturnValue({
      messages: [{ role: "assistant", metadata: { usage: { inputTokens: 1_000 } } }],
    })
    const ctx = makeCtx({ activeSessionId: "s" })
    await handleContext(ctx)
    const block = ctx._pushed[0] as Extract<Pushed, { kind: "context" }>
    expect(block.window?.used).toBe(1_000)
    expect(block.window?.max).toBe(400_000)
  })
})

describe("handleCompact", () => {
  it("warns and does not call the sidecar when there is no active session", async () => {
    const ctx = makeCtx({ activeSessionId: null })
    await handleCompact(ctx)
    expect(ctx._pushed[0]).toContain("No active session")
    expect(mockedCompact).not.toHaveBeenCalled()
  })

  it("routes a compaction request for the active session", async () => {
    const ctx = makeCtx({ activeSessionId: "s1" })
    await handleCompact(ctx)
    expect(mockedCompact).toHaveBeenCalledWith("s1", undefined)
  })

  it("passes the focus argument through", async () => {
    const ctx = makeCtx({ activeSessionId: "s1", args: "  the API changes  " })
    await handleCompact(ctx)
    expect(mockedCompact).toHaveBeenCalledWith("s1", "the API changes")
  })
})
