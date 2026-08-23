import type { McpServer } from "@cognia/agent-config-types"

import { isTauri } from "@/lib/tauri"
import {
  mcpOAuthLoadEntry,
  mcpOAuthRefresh,
  type McpOAuthEntry,
  type McpServerDescriptor,
} from "./oauth-tauri"

export interface ResolvedMcpRuntimeCredential {
  server: McpServer
  refreshAuth?: () => Promise<{ server: McpServer }>
}

interface CredentialResolverDeps {
  isDesktop?: () => boolean
  now?: () => number
  loadEntry?: typeof mcpOAuthLoadEntry
  refresh?: typeof mcpOAuthRefresh
  refreshSkewMs?: number
}

/** Resolve keychain OAuth for every governed runtime without exposing tokens to Agent context. */
export async function resolveMcpRuntimeCredential(
  server: McpServer,
  deps: CredentialResolverDeps = {}
): Promise<ResolvedMcpRuntimeCredential> {
  if (server.transport === "stdio" || !(deps.isDesktop ?? isTauri)()) return { server }
  const descriptor: McpServerDescriptor = { transport: server.transport, config: server.config }
  const loadEntry = deps.loadEntry ?? mcpOAuthLoadEntry
  const refresh = deps.refresh ?? mcpOAuthRefresh
  const now = deps.now ?? (() => Date.now())
  const refreshSkewMs = deps.refreshSkewMs ?? 60_000
  let entry = await loadEntry(server.id, server.name, descriptor)
  if (entry?.expiresAtMs && entry.expiresAtMs - now() < refreshSkewMs) {
    entry = (await refresh(server.id, descriptor)) ?? entry
  }

  const project = (token: McpOAuthEntry | undefined, credentialVersion = 0): McpServer => {
    if (!token?.accessToken) return server
    const headers =
      server.config.headers && typeof server.config.headers === "object"
        ? (server.config.headers as Record<string, unknown>)
        : {}
    return {
      ...server,
      credentialVersion: (server.credentialVersion ?? 0) + credentialVersion,
      config: {
        ...server.config,
        headers: { ...headers, Authorization: `Bearer ${token.accessToken}` },
      },
    }
  }

  return {
    server: project(entry),
    refreshAuth: async () => ({
      server: project(await refresh(server.id, descriptor), 1),
    }),
  }
}
