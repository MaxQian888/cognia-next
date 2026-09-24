/** Combine desired configuration and runtime evidence without promoting local probes. */
import type { McpServer } from "@cognia/agent-config-types"
import { mcpServerToAcpConfig } from "@/lib/ai/agent/external/runtimes/acp/resolve-acp-mcp-servers"
import {
  mcpConfigVersion,
  type SessionMcpSnapshot,
  type SessionMcpServer,
} from "../../agent/tool-host/mcp-status"
import type { ResolvedConfig } from "../../config/schema"
import { createCliTranslator } from "../i18n"
import type { McpPanelServer } from "./mcp-panel-model"

export function runtimeMcpRowId(server: SessionMcpServer): string {
  return `runtime:${server.source}:${encodeURIComponent(server.name)}`
}

export function sessionMcpRows(
  local: McpPanelServer[],
  configured: McpServer[],
  config: ResolvedConfig,
  snapshot?: SessionMcpSnapshot
): McpPanelServer[] {
  const backend = config.agentBackend ?? "builtin"
  const live = snapshot?.backend === backend ? snapshot : undefined
  const t = createCliTranslator(config.locale, "cliUiCommon")
  const rows = local.map((row): McpPanelServer => {
    const server = configured.find((s) => s.name === row.name)!
    const applied = live?.servers.find((s) => s.source === "cognia" && s.name === row.name)
    const desired = mcpServerToAcpConfig(server)
    let sessionStatus: McpPanelServer["sessionStatus"]
    let sessionError: string | undefined
    if (!server.enabled) {
      sessionStatus =
        applied && applied.reasonCode !== "protocol_unsupported" ? "pending" : "disabled"
    } else if (!desired || backend === "pi-rpc" || applied?.reasonCode === "protocol_unsupported") {
      sessionStatus = "unsupported"
      sessionError = t("mcpSession.unsupported")
    } else if (backend === "builtin") {
      sessionStatus = "unknown"
      sessionError = t("mcpSession.probeOnly")
    } else if (!applied || live?.pending || applied.configVersion !== mcpConfigVersion(desired)) {
      sessionStatus = "pending"
    } else {
      sessionStatus = applied.state === "forwarded" ? "submitted" : applied.state
      sessionError =
        applied.error ?? (applied.state === "forwarded" ? t("mcpSession.unconfirmed") : undefined)
    }
    return {
      ...row,
      source: "cognia",
      sessionStatus,
      sessionError,
      ...(applied?.toolNames ? { sessionToolCount: applied.toolNames.length } : {}),
      ...(live?.servers.some((s) => s.source !== "cognia" && s.name === row.name)
        ? { conflict: t("mcpSession.namesake") }
        : {}),
    }
  })
  for (const server of live?.servers ?? []) {
    // Removed configuration can remain active until the next explicit apply.
    if (server.source === "cognia" && configured.some((s) => s.name === server.name)) continue
    rows.push({
      id: runtimeMcpRowId(server),
      name: server.name,
      source: server.source,
      readOnly: true,
      transport: "—",
      enabled: true,
      status: "unknown",
      sessionStatus:
        server.source === "cognia"
          ? "pending"
          : server.reasonCode === "protocol_unsupported"
            ? "unsupported"
            : server.state === "forwarded"
              ? "submitted"
              : server.state,
      sessionScope: server.scope,
      sessionError: server.error,
      ...(server.toolNames ? { sessionToolCount: server.toolNames.length } : {}),
      ...(configured.some((s) => s.name === server.name)
        ? { conflict: t("mcpSession.namesake") }
        : {}),
    })
  }
  return rows
}
