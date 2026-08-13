import type { SandboxResourcePolicy } from "@cognia/agent-config-types"

import type { AcpPermissionMode } from "@/types/agent/external-agent"

/**
 * Canonical permission ceiling shared by direct agents, Agent Teams,
 * workflows, plugins, and external-agent sessions.
 *
 * Every nested execution may only narrow this surface; it must never widen it.
 */
export interface AgentPermissionCeiling {
  permissionMode?: AcpPermissionMode
  allowedTools?: string[]
  disallowedTools?: string[]
  mcpServers?: Array<{ name: string; [key: string]: unknown }>
  sandboxPolicy?: SandboxResourcePolicy
}
