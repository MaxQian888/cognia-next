/** @jest-environment node */
import {
  applySessionMcpStatus,
  clearSessionMcpStatus,
  forwardedMcpServers,
  markSessionMcpPending,
  mcpConfigVersion,
  mergeAgentMcpEvidence,
  publishSessionMcpStatus,
  readSessionMcpStatus,
  refreshSessionMcpStatus,
  registerSessionMcpStatus,
  subscribeSessionMcpStatus,
  type SessionMcpSnapshot,
} from "./mcp-status"

const snapshot = (): SessionMcpSnapshot => ({
  backend: "codex",
  telemetry: "unsupported",
  servers: forwardedMcpServers([{ name: "github", command: "server", args: [] }], new Set(), true),
})
afterEach(() => clearSessionMcpStatus("session"))
test("fingerprints are stable and do not expose credentials", () => {
  expect(mcpConfigVersion({ name: "a", env: { token: "secret", a: "x" } })).toBe(
    mcpConfigVersion({ env: { a: "x", token: "secret" }, name: "a" })
  )
  expect(mcpConfigVersion({ token: "secret" })).not.toContain("secret")
  expect(mcpConfigVersion({ token: "secret" })).not.toBe(mcpConfigVersion({ token: "changed" }))
})
test("unsupported protocols cannot report that configuration was forwarded", () => {
  expect(
    forwardedMcpServers(
      [{ name: "cognia-tools", command: "bridge", args: [] }],
      new Set(["cognia-tools"]),
      false
    )[0]
  ).toMatchObject({ source: "bridge", state: "unknown", reasonCode: "protocol_unsupported" })
})
test("process inventory never confirms a namesake session configuration", () => {
  const result = mergeAgentMcpEvidence(snapshot(), [{ name: "github", tools: { search: {} } }])
  expect(result.servers).toEqual([
    expect.objectContaining({ name: "github", source: "cognia", state: "forwarded" }),
    expect.objectContaining({
      name: "github",
      source: "agent",
      state: "available",
      scope: "agent",
      toolNames: ["search"],
    }),
  ])
})
test("auth, errors and unknown native states retain their actual evidence", () => {
  const result = mergeAgentMcpEvidence(snapshot(), [
    { name: "login", authStatus: "notLoggedIn", tools: {} },
    { name: "failed", status: "failed" },
    { name: "unknown" },
    {},
  ])
  expect(result.servers.slice(1).map((row) => row.state)).toEqual([
    "needs_auth",
    "failed",
    "unknown",
  ])
  expect(mergeAgentMcpEvidence(result, []).servers).toHaveLength(1)
})
test("registry supports live updates, pending state and explicit restart consent", async () => {
  const apply = jest.fn(async () => ({ restarted: false, requiresRestart: true }))
  registerSessionMcpStatus("session", { apply })
  const listener = jest.fn()
  const unsubscribe = subscribeSessionMcpStatus("session", listener)
  publishSessionMcpStatus("session", snapshot())
  markSessionMcpPending("session")
  expect(readSessionMcpStatus("session")?.pending).toBe(true)
  expect(listener).toHaveBeenCalledTimes(2)
  expect(await refreshSessionMcpStatus("session")).toEqual(readSessionMcpStatus("session"))
  await applySessionMcpStatus("session")
  expect(apply).toHaveBeenLastCalledWith(false)
  await applySessionMcpStatus("session", true)
  expect(apply).toHaveBeenLastCalledWith(true)
  unsubscribe()
  clearSessionMcpStatus("session")
  expect(readSessionMcpStatus("session")).toBeUndefined()
  await expect(applySessionMcpStatus("session")).rejects.toThrow("No active")
})

test("null or starting runtime status cannot be promoted by cached tools", () => {
  const result = mergeAgentMcpEvidence({ ...snapshot(), externalSessionId: "thread" }, [
    { name: "cached", runtimeStatus: null, tools: { read: {} } },
    { name: "starting", runtimeStatus: "starting", tools: { read: {} } },
    { name: "connected", runtimeStatus: "connected", tools: {} },
    { name: "auth", runtimeStatus: "authenticationRequired", tools: {} },
    { name: "discovery", toolsError: "failed", tools: {} },
  ])
  expect(result.servers.slice(1).map((row) => row.state)).toEqual([
    "unknown",
    "unknown",
    "available",
    "needs_auth",
    "failed",
  ])
  expect(result.servers[3].scope).toBe("session")
})
