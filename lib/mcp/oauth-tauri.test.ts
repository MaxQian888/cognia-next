/**
 * @jest-environment node
 */
const callMock = jest.fn()
jest.mock("@/lib/tauri", () => ({ transport: { call: (...a: unknown[]) => callMock(...a) } }))
jest.mock("@/lib/claude/builtin-mcp/runtime-context", () => ({
  getBuiltinMcpRuntimeContext: async () => ({ sidecarDir: "/sc", socketPath: "" }),
}))

import {
  mcpOAuthStatus,
  mcpOAuthLoadEntry,
  mcpOAuthRefresh,
  mcpOAuthAuthenticate,
  mcpOAuthClear,
} from "./oauth-tauri"

beforeEach(() => callMock.mockReset())

describe("oauth-tauri wrappers", () => {
  it("mcpOAuthStatus maps snake_case → camelCase", async () => {
    callMock.mockResolvedValue({ has_tokens: true, expires_at_ms: 123 })
    const s = await mcpOAuthStatus("srv")
    expect(callMock).toHaveBeenCalledWith("mcp_oauth_status", { serverName: "srv" })
    expect(s).toEqual({ hasTokens: true, expiresAtMs: 123 })
  })

  it("mcpOAuthStatus normalizes a null expiry to undefined", async () => {
    callMock.mockResolvedValue({ has_tokens: false, expires_at_ms: null })
    expect(await mcpOAuthStatus("srv")).toEqual({ hasTokens: false, expiresAtMs: undefined })
  })

  it("mcpOAuthLoadEntry returns undefined when there is no access token", async () => {
    callMock.mockResolvedValue(null)
    expect(await mcpOAuthLoadEntry("srv")).toBeUndefined()
    callMock.mockResolvedValue({ access_token: null })
    expect(await mcpOAuthLoadEntry("srv")).toBeUndefined()
  })

  it("mcpOAuthLoadEntry projects the token + expiry", async () => {
    callMock.mockResolvedValue({ access_token: "t", expires_at_ms: 9 })
    expect(await mcpOAuthLoadEntry("srv")).toEqual({ accessToken: "t", expiresAtMs: 9 })
  })

  const desc = { transport: "http" as const, config: { url: "https://x" } }

  it("mcpOAuthRefresh projects the refreshed token and resolves the helper path", async () => {
    callMock.mockResolvedValue({ access_token: "new", expires_at_ms: null })
    expect(await mcpOAuthRefresh("srv", desc)).toEqual({
      accessToken: "new",
      expiresAtMs: undefined,
    })
    expect(callMock).toHaveBeenCalledWith("mcp_oauth_refresh", {
      serverName: "srv",
      server: desc,
      helperPath: "/sc/mcp-oauth-helper.mjs",
    })
  })

  it("mcpOAuthAuthenticate forwards server + helper path and the structured result", async () => {
    callMock.mockResolvedValue({ ok: true, status: "authorized", message: "ok" })
    const r = await mcpOAuthAuthenticate("srv", desc)
    expect(callMock).toHaveBeenCalledWith("mcp_oauth_authenticate", {
      serverName: "srv",
      server: desc,
      helperPath: "/sc/mcp-oauth-helper.mjs",
    })
    expect(r.status).toBe("authorized")
  })

  it("mcpOAuthClear calls the clear command", async () => {
    callMock.mockResolvedValue(undefined)
    await mcpOAuthClear("srv")
    expect(callMock).toHaveBeenCalledWith("mcp_oauth_clear", { serverName: "srv" })
  })
})
