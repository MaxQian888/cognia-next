import type { McpServer } from "@cognia/agent-config-types"
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import { z } from "zod"

import { resolveMcpRuntimeCredential } from "@/lib/mcp/credential-resolver"
import { openMcpClient, type OpenedMcp } from "@/lib/mcp/transport"
import type {
  AcpConnectMcpRequest,
  AcpConnectMcpResponse,
  AcpDisconnectMcpRequest,
  AcpDisconnectMcpResponse,
  AcpDynamicMcpHostController,
  AcpMessageMcpNotification,
  AcpMessageMcpRequest,
  AcpMessageMcpResponse,
} from "@/types/agent/external-agent"

interface DynamicMcpConnection {
  sessionId: string
  opened: OpenedMcp
}

interface DynamicMcpControllerDeps {
  getServer?: (serverId: string) => Promise<McpServer | undefined>
  open?: typeof openMcpClient
  createConnectionId?: () => string
}

function defaultConnectionId(): string {
  return `acp_mcp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Governed bridge for preview MCP-over-ACP. Server definitions and credentials
 * stay in Cognia's registry/keyring; ACP receives only the opaque server id and
 * inner MCP payloads.
 */
export class CogniaAcpDynamicMcpController implements AcpDynamicMcpHostController {
  private readonly connections = new Map<string, DynamicMcpConnection>()

  constructor(private readonly deps: DynamicMcpControllerDeps = {}) {}

  async connect(
    request: AcpConnectMcpRequest,
    context: {
      sessionId: string
      signal: AbortSignal
      notify: (notification: AcpMessageMcpNotification) => void
    }
  ): Promise<AcpConnectMcpResponse> {
    const getServer =
      this.deps.getServer ??
      (async (serverId: string) => (await import("@/lib/db/mcp-servers")).getMcpServer(serverId))
    const server = await getServer(request.serverId)
    if (!server || !server.enabled) {
      throw new Error(`Enabled MCP server ${request.serverId} was not found`)
    }
    const credential = await resolveMcpRuntimeCredential(server)
    const opened = await (this.deps.open ?? openMcpClient)(credential.server, {
      signal: context.signal,
      surface: "agent-sync",
      interactive: false,
      clientInfo: { name: "cognia-acp", version: "1.21.0" },
    })
    const connectionId = (this.deps.createConnectionId ?? defaultConnectionId)()
    if (!connectionId || this.connections.has(connectionId)) {
      await opened.close()
      throw new Error("Dynamic MCP connection id collision")
    }
    opened.client.fallbackNotificationHandler = async (notification) => {
      context.notify({
        connectionId,
        method: notification.method,
        ...(notification.params ? { params: notification.params } : {}),
      })
    }
    this.connections.set(connectionId, { sessionId: context.sessionId, opened })
    return { connectionId }
  }

  async message(
    request: AcpMessageMcpRequest | AcpMessageMcpNotification,
    context: { sessionId: string; signal?: AbortSignal; notification: boolean }
  ): Promise<AcpMessageMcpResponse | void> {
    const connection = this.connections.get(request.connectionId)
    if (!connection || connection.sessionId !== context.sessionId) {
      throw new Error(`Unknown MCP-over-ACP connection: ${request.connectionId}`)
    }
    if (!hasNoLeakingPiiDeep({ method: request.method, params: request.params })) {
      throw new Error("MCP-over-ACP payload was blocked by the PII egress gate")
    }
    const message = {
      method: request.method,
      ...(request.params ? { params: request.params } : {}),
    }
    if (context.notification) {
      if (!connection.opened.client.notification) {
        throw new Error("MCP client does not support notifications")
      }
      await connection.opened.client.notification(message, { signal: context.signal })
      return
    }
    if (!connection.opened.client.request) {
      throw new Error("MCP client does not support raw requests")
    }
    return connection.opened.client.request(message, z.unknown(), { signal: context.signal })
  }

  async disconnect(
    request: AcpDisconnectMcpRequest,
    context: { sessionId: string }
  ): Promise<AcpDisconnectMcpResponse> {
    const connection = this.connections.get(request.connectionId)
    if (!connection || connection.sessionId !== context.sessionId) {
      return {}
    }
    this.connections.delete(request.connectionId)
    await connection.opened.close()
    return {}
  }
}

export function createAcpDynamicMcpHostController(): AcpDynamicMcpHostController {
  return new CogniaAcpDynamicMcpController()
}
