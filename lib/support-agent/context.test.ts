jest.mock("@/lib/app-version", () => ({ APP_VERSION: "2.4.0" }))

import {
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
  it("recognizes only the immutable built-in id", () => {
    expect(isSupportAgentId(SUPPORT_AGENT_ID)).toBe(true)
    expect(isSupportAgentId("char_custom_support")).toBe(false)
  })

  it("stores an explicit local diagnostics kill switch", () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    } as Storage
    expect(isSupportDiagnosticsEnabled(storage)).toBe(true)
    setSupportDiagnosticsEnabled(false, storage)
    expect(values.get(SUPPORT_DIAGNOSTICS_STORAGE_KEY)).toBe("false")
    expect(isSupportDiagnosticsEnabled(storage)).toBe(false)
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
      userText: "如何创建项目？",
      diagnosticsEnabled: true,
      readDiagnostics: jest.fn(),
    })
    expect(context).toContain("Bundled app version: 2.4.0")
    expect(context).toContain("Cognia 是本地优先")
    expect(context).toContain("docs/content/docs/zh/")
    expect(context).not.toContain("Redacted local diagnostics")
  })

  it("includes only redacted, bounded diagnostics when requested", async () => {
    const context = await buildSupportAgentContext({
      locale: "en",
      userText: "diagnose this crash",
      diagnosticsEnabled: true,
      readDiagnostics: jest.fn(async () => ({ status: "error", hostname: "private-host" } as never)),
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
      })
    ).toEqual(
      expect.objectContaining({
        permissionMode: "plan",
        allowedTools: [],
        mcpServers: {},
      })
    )
    const safe = applySupportAgentSafety({ env: {}, cwd: "/tmp", agents: {} })
    expect(safe).not.toHaveProperty("env")
    expect(safe).not.toHaveProperty("cwd")
    expect(safe).not.toHaveProperty("agents")
  })
})
