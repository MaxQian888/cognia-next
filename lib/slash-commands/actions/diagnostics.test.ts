jest.mock("@/lib/claude/ipc", () => ({
  getSidecarStatus: jest.fn(),
  hasApiKey: jest.fn(),
  hasOauthBearer: jest.fn(),
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

import { handleStatus, handleCost, handleContext, handleDoctor } from "./diagnostics"
import { getSidecarStatus, hasApiKey, hasOauthBearer } from "@/lib/claude/ipc"
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

function makeCtx(overrides: Partial<SlashContext> = {}): SlashContext & { _pushed: string[] } {
  const pushed: string[] = []
  return {
    args: "",
    activeSessionId: null,
    chatStatus: "ready",
    currentPermissionMode: null,
    startNewSession: () => undefined,
    openSettings: () => undefined,
    setPermissionMode: () => undefined,
    pushSystemMessage: (md: string) => {
      pushed.push(md)
    },
    _pushed: pushed,
    ...overrides,
  } as SlashContext & { _pushed: string[] }
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
    const md = ctx._pushed[0]
    expect(md).toContain("Turns**: 2 assistant (2 with metrics)")
    expect(md).toContain("Input tokens**: 1,500")
    expect(md).toContain("Output tokens**: 2,000")
    expect(md).toContain("Cache**: write 300 / read 100")
    expect(md).toContain("Cost**: $0.0500 USD")
    expect(md).toContain("Duration**: 1.5s")
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
    const md = ctx._pushed[0]
    expect(md).toContain("Input tokens**: 1")
    expect(md).not.toContain("Cache**")
    expect(md).not.toContain("Cost**")
    expect(md).not.toContain("Duration**")
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
    const md = ctx._pushed[0]
    expect(md).toContain("**Context**")
    expect(md).toContain("Messages: 1 user · 0 assistant")
    expect(md).toContain("context window is fresh")
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
    const md = ctx._pushed[0]
    expect(md).toContain("Messages: 1 user · 2 assistant")
    // input + cache reads + cache creation = 1200 + 100 + 200 = 1500
    expect(md).toContain("Input tokens (incl. cache): 1,500")
    expect(md).toContain("Output tokens: 800")
    expect(md).toContain("write 200 / read 100")
    expect(md).toContain("/compact")
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
    const md = ctx._pushed[0]
    expect(md).toContain("Input tokens (incl. cache): 10")
    expect(md).not.toContain("Cache hits")
  })
})
