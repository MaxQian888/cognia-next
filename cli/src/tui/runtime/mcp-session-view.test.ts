/** @jest-environment node */
import type { McpServer } from "@cognia/agent-config-types"
import { mcpServerToAcpConfig } from "@/lib/ai/agent/external/runtimes/acp/resolve-acp-mcp-servers"
import { DEFAULT_RESOLVED_CONFIG } from "../../config/schema"
import { mcpConfigVersion, type SessionMcpSnapshot } from "../../agent/tool-host/mcp-status"
import { sessionMcpRows, runtimeMcpRowId } from "./mcp-session-view"
import type { McpPanelServer } from "./mcp-panel-model"

const server = {
  id: "one",
  name: "files",
  transport: "stdio",
  enabled: true,
  config: { command: "node", args: ["mcp.js"] },
} as McpServer
const config = { ...DEFAULT_RESOLVED_CONFIG, cwd: "/work", agentBackend: "codex" }
const row: McpPanelServer = {
  name: "files",
  transport: "stdio",
  enabled: true,
  status: "connected",
  toolCount: 7,
}
const snapshot: SessionMcpSnapshot = {
  backend: "codex",
  telemetry: "unsupported",
  servers: [
    {
      name: "files",
      source: "cognia",
      state: "forwarded",
      configVersion: mcpConfigVersion(mcpServerToAcpConfig(server)),
    },
  ],
}

it("does not turn a successful local probe into agent availability", () => {
  const [result] = sessionMcpRows([row], [server], config, snapshot)
  expect(result.status).toBe("connected")
  expect(result.sessionStatus).toBe("submitted")
  expect(result.sessionToolCount).toBeUndefined()
})
it("marks changed credentials and disabled applied configurations pending", () => {
  const changed = { ...server, config: { ...server.config, env: { TOKEN: "different" } } }
  expect(sessionMcpRows([row], [changed], config, snapshot)[0].sessionStatus).toBe("pending")
  expect(
    sessionMcpRows([row], [{ ...server, enabled: false }], config, snapshot)[0].sessionStatus
  ).toBe("pending")
  expect(sessionMcpRows([row], [{ ...server, enabled: false }], config)[0].sessionStatus).toBe(
    "disabled"
  )
  expect(
    sessionMcpRows([row], [server], config, { ...snapshot, pending: true })[0].sessionStatus
  ).toBe("pending")
})
it("keeps removed but still applied servers visible as pending read-only rows", () => {
  const [result] = sessionMcpRows([], [], config, snapshot)
  expect(result).toMatchObject({ readOnly: true, sessionStatus: "pending", status: "unknown" })
})
it("keeps same-name native inventory separate from supplied config", () => {
  const native = {
    name: "files",
    source: "agent" as const,
    state: "available" as const,
    toolNames: ["read"],
    scope: "agent" as const,
  }
  const results = sessionMcpRows([row], [server], config, {
    ...snapshot,
    servers: [...snapshot.servers, native],
  })
  expect(results).toHaveLength(2)
  expect(results[0].sessionStatus).toBe("submitted")
  expect(results[1]).toMatchObject({
    id: runtimeMcpRowId(native),
    sessionToolCount: 1,
    sessionScope: "agent",
    readOnly: true,
  })
  expect(results.every((item) => item.conflict)).toBe(true)
})
it("rejects stale evidence from a previous backend", () => {
  expect(
    sessionMcpRows([row], [server], config, { ...snapshot, backend: "claude" })[0].sessionStatus
  ).toBe("pending")
})
it("reports unsupported Pi configuration and malformed external configuration", () => {
  expect(
    sessionMcpRows([row], [server], { ...config, agentBackend: "pi-rpc" })[0].sessionStatus
  ).toBe("unsupported")
  expect(sessionMcpRows([row], [{ ...server, config: {} }], config)[0].sessionStatus).toBe(
    "unsupported"
  )
})
it("keeps built-in probe-only evidence unknown", () => {
  expect(
    sessionMcpRows([row], [server], { ...config, agentBackend: "builtin" })[0].sessionStatus
  ).toBe("unknown")
})
it("carries actual scoped runtime failures and available tool counts", () => {
  const live: SessionMcpSnapshot = {
    ...snapshot,
    servers: [
      { ...snapshot.servers[0], state: "failed", error: "connection refused", toolNames: [] },
    ],
  }
  expect(sessionMcpRows([row], [server], config, live)[0]).toMatchObject({
    sessionStatus: "failed",
    sessionError: "connection refused",
    sessionToolCount: 0,
  })
})
