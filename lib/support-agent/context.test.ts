jest.mock("@/lib/app-version", () => ({ APP_VERSION: "2.4.0" }))

import {
  SUPPORT_AGENT_CANONICAL_ID,
  SUPPORT_AGENT_ID,
  SUPPORT_DIAGNOSTICS_STORAGE_KEY,
  applySupportAgentSafety,
  buildSupportAgentContext,
  isSupportAgentId,
  isSupportDiagnosticsEnabled,
  setSupportDiagnosticsEnabled,
  shouldReadSupportDiagnostics,
} from "./context"

describe("Support Agent identity and diagnostics kill switch", () => {
  it("recognizes both immutable built-in identities without matching user characters", () => {
    expect(isSupportAgentId(SUPPORT_AGENT_ID)).toBe(true)
    expect(isSupportAgentId(SUPPORT_AGENT_CANONICAL_ID)).toBe(true)
    expect(isSupportAgentId("char_custom_support")).toBe(false)
  })

  it("requires explicit local consent before diagnostics are enabled", () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value)
      },
    } as unknown as Storage
    expect(isSupportDiagnosticsEnabled(storage)).toBe(false)
    setSupportDiagnosticsEnabled(true, storage)
    expect(values.get(SUPPORT_DIAGNOSTICS_STORAGE_KEY)).toBe("true")
    expect(isSupportDiagnosticsEnabled(storage)).toBe(true)
  })

  it("reads diagnostics only for troubleshooting intent", () => {
    expect(shouldReadSupportDiagnostics("why did the runtime crash?")).toBe(true)
    expect(shouldReadSupportDiagnostics("帮我排障")).toBe(true)
    expect(shouldReadSupportDiagnostics("how do I create a project?")).toBe(false)
  })
})

describe("buildSupportAgentContext", () => {
  it("selects bilingual, current-version bundled documentation", async () => {
    const context = await buildSupportAgentContext({
      locale: "zh-CN",
      userText: "如何配置 MCP 服务器？",
      diagnosticsEnabled: true,
      readDiagnostics: jest.fn(),
    })
    expect(context).toContain("Bundled app version: 2.4.0")
    expect(context).toContain("MCP")
    expect(context).toContain("docs/content/docs/zh/")
    expect(context).not.toContain("Redacted local diagnostics")
  })

  it("includes only redacted, bounded diagnostics when requested", async () => {
    const context = await buildSupportAgentContext({
      locale: "en",
      userText: "diagnose this crash",
      diagnosticsEnabled: true,
      readDiagnostics: jest.fn(
        async () => ({ status: "error", hostname: "private-host" }) as never
      ),
    })
    expect(context).toContain("Redacted local diagnostics")
    expect(context.length).toBeLessThan(10_000)
  })

  it("honors the kill switch without touching diagnostics", async () => {
    const readDiagnostics = jest.fn()
    await buildSupportAgentContext({
      userText: "diagnose failure",
      diagnosticsEnabled: false,
      readDiagnostics,
    })
    expect(readDiagnostics).not.toHaveBeenCalled()
  })

  it("serializes the exact redacted and bounded diagnostic payload used by Support", async () => {
    const { serializeSupportDiagnostics } = await import("./context")
    const serialized = serializeSupportDiagnostics({
      status: "error",
      hostname: "private-host",
      health: { sidecar: { status: "not-ready" } },
    })
    expect(serialized).toContain('"status": "error"')
    expect(serialized).toContain('"sidecar"')
    expect(serialized.length).toBeLessThanOrEqual(6_000)
  })
})

describe("applySupportAgentSafety", () => {
  it("removes host, keyring-adjacent, MCP, and subagent capabilities", () => {
    expect(
      applySupportAgentSafety({
        permissionMode: "bypassPermissions",
        allowedTools: ["Bash"],
        env: { SECRET: "value" },
        cwd: "/tmp",
        mcpServers: { unsafe: {} },
        agents: { helper: {} },
        builtinTools: { browser: true },
        pluginTools: [
          {
            name: "web_search",
            description: "Search the web",
            jsonSchema: { type: "object" },
            pluginId: "cognia-web-builtin",
          },
        ],
        lsp: { enabled: true },
        anthropicTools: [{ type: "computer_20250124", name: "computer" }],
        toolResultReviewEnabled: true,
        toolSearchEnabled: true,
        alwaysLoadServers: ["unsafe"],
        alwaysLoadTools: ["write"],
      })
    ).toEqual(
      expect.objectContaining({
        permissionMode: "plan",
        toolSurface: "none",
        allowedTools: [],
        mcpServers: {},
      })
    )
    const safe = applySupportAgentSafety({ env: {}, cwd: "/tmp", agents: {} })
    expect(safe).not.toHaveProperty("env")
    expect(safe).not.toHaveProperty("cwd")
    expect(safe).not.toHaveProperty("agents")
    expect(safe).not.toHaveProperty("pluginTools")
    expect(safe).not.toHaveProperty("builtinTools")
    expect(safe).not.toHaveProperty("lsp")
    expect(safe).not.toHaveProperty("anthropicTools")
    expect(safe).not.toHaveProperty("toolResultReviewEnabled")
    expect(safe).not.toHaveProperty("toolSearchEnabled")
    expect(safe).not.toHaveProperty("alwaysLoadServers")
    expect(safe).not.toHaveProperty("alwaysLoadTools")
  })
})
