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

  it("falls back to the one-release legacy name key", async () => {
    callMock.mockResolvedValueOnce(null).mockResolvedValueOnce({ access_token: "legacy" })
    expect(await mcpOAuthLoadEntry("mcp-id", "old-name")).toEqual({
      accessToken: "legacy",
      expiresAtMs: undefined,
    })
    expect(callMock).toHaveBeenNthCalledWith(1, "mcp_oauth_load_entry", {
      serverName: "mcp-id",
    })
    expect(callMock).toHaveBeenNthCalledWith(2, "mcp_oauth_load_entry", {
      serverName: "old-name",
    })
  })

  const desc = { transport: "http" as const, config: { url: "https://x" } }

  it("mcpOAuthRefresh projects the refreshed token and resolves the helper path", async () => {
    callMock.mockResolvedValue({ access_token: "new", expires_at_ms: null })
    expect(await mcpOAuthRefresh("srv", desc)).toEqual({
      accessToken: "new",
      expiresAtMs: undefined,
    })
    expect(callMock).toHaveBeenCalledWith("mcp_oauth_refresh", {
      serverName: expect.stringMatching(/^srv:[a-f0-9]{32}:[a-f0-9]{16}$/),
      server: desc,
      helperPath: "/sc/mcp-oauth-helper.mjs",
    })
  })

  it("mcpOAuthAuthenticate forwards server + helper path and the structured result", async () => {
    callMock.mockResolvedValue({ ok: true, status: "authorized", message: "ok" })
    const r = await mcpOAuthAuthenticate("srv", desc)
    expect(callMock).toHaveBeenCalledWith("mcp_oauth_authenticate", {
      serverName: expect.stringMatching(/^srv:[a-f0-9]{32}:[a-f0-9]{16}$/),
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

  it("never falls back from an endpoint partition to an origin-unknown legacy token", async () => {
    callMock.mockResolvedValueOnce({ has_tokens: false })
    await expect(mcpOAuthStatus("srv", undefined, desc)).resolves.toEqual({
      hasTokens: false,
      expiresAtMs: undefined,
    })
    expect(callMock.mock.calls[0][1].serverName).toMatch(/^srv:[a-f0-9]{32}:[a-f0-9]{16}$/)
    expect(callMock).toHaveBeenCalledTimes(1)
  })

  it("clears the endpoint partition and migration keys", async () => {
    callMock.mockResolvedValue(undefined)
    await mcpOAuthClear("srv", "old-name", desc)
    expect(callMock.mock.calls[0][1].serverName).toMatch(/^srv:[a-f0-9]{32}:[a-f0-9]{16}$/)
    expect(callMock).toHaveBeenNthCalledWith(2, "mcp_oauth_clear", { serverName: "srv" })
    expect(callMock).toHaveBeenNthCalledWith(3, "mcp_oauth_clear", { serverName: "old-name" })
  })
})
