/** Session-owned MCP evidence. Local connection probes must never populate this registry. */
import { createHash } from "node:crypto"
import type { AcpMcpServerConfig } from "@/types/agent/external-agent"

export interface SessionMcpServer {
  name: string
  source: "cognia" | "bridge" | "agent"
  state: "forwarded" | "available" | "failed" | "needs_auth" | "unknown"
  configVersion?: string
  toolNames?: string[]
  error?: string
  scope?: "session" | "agent"
  reasonCode?: "protocol_unsupported" | "unconfirmed"
}
export interface SessionMcpSnapshot {
  backend: string
  externalSessionId?: string
  appliedConfigVersion?: string
  pending?: boolean
  error?: string
  telemetry: "supported" | "unsupported" | "failed"
  servers: SessionMcpServer[]
}
export interface AgentMcpEvidence {
  name?: string
  status?: string
  authStatus?: string
  runtimeStatus?: string | null
  toolsError?: string | null
  tools?: Array<{ name?: string }> | Record<string, unknown>
  [key: string]: unknown
}
interface Registration {
  snapshot?: SessionMcpSnapshot
  refresh?: () => Promise<SessionMcpSnapshot | undefined>
  apply: (
    allowRestart?: boolean
  ) => Promise<{ snapshot?: SessionMcpSnapshot; restarted: boolean; requiresRestart?: boolean }>
}
const sessions = new Map<string, Registration>()
const listeners = new Map<string, Set<() => void>>()
export function subscribeSessionMcpStatus(sessionId: string, listener: () => void): () => void {
  const group = listeners.get(sessionId) ?? new Set<() => void>()
  group.add(listener)
  listeners.set(sessionId, group)
  return () => {
    group.delete(listener)
    if (!group.size) listeners.delete(sessionId)
  }
}
function notify(sessionId: string): void {
  for (const listener of listeners.get(sessionId) ?? []) listener()
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)])
    )
  return value
}
/** Fingerprint only: never expose credentials or connection arguments in status. */
export function mcpConfigVersion(config: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(config)))
    .digest("hex")
}
export function registerSessionMcpStatus(
  sessionId: string,
  registration: Omit<Registration, "snapshot">
): void {
  sessions.set(sessionId, registration)
}
export function publishSessionMcpStatus(sessionId: string, snapshot: SessionMcpSnapshot): void {
  const registration = sessions.get(sessionId)
  if (registration) {
    registration.snapshot = snapshot
    notify(sessionId)
  }
}
export function readSessionMcpStatus(sessionId: string): SessionMcpSnapshot | undefined {
  return sessions.get(sessionId)?.snapshot
}
export function markSessionMcpPending(sessionId: string): void {
  const snapshot = readSessionMcpStatus(sessionId)
  if (snapshot) publishSessionMcpStatus(sessionId, { ...snapshot, pending: true })
}
export function clearSessionMcpStatus(sessionId: string): void {
  sessions.delete(sessionId)
  notify(sessionId)
}
export async function refreshSessionMcpStatus(
  sessionId: string
): Promise<SessionMcpSnapshot | undefined> {
  const registration = sessions.get(sessionId)
  if (!registration?.refresh) return registration?.snapshot
  return registration.refresh()
}
export async function applySessionMcpStatus(
  sessionId: string,
  allowRestart = false
): Promise<{ snapshot?: SessionMcpSnapshot; restarted: boolean; requiresRestart?: boolean }> {
  const registration = sessions.get(sessionId)
  if (!registration) throw new Error("No active external agent session")
  return registration.apply(allowRestart)
}
export function forwardedMcpServers(
  servers: AcpMcpServerConfig[],
  bridgeNames: Set<string>,
  supported: boolean
): SessionMcpServer[] {
  return servers.map((server) => ({
    name: server.name,
    source: bridgeNames.has(server.name) ? "bridge" : "cognia",
    state: supported ? "forwarded" : "unknown",
    configVersion: mcpConfigVersion(server),
    scope: "session",
    reasonCode: supported ? "unconfirmed" : "protocol_unsupported",
  }))
}
/** Codex inventory is process-scoped. A namesake alone cannot confirm session config identity. */
export function mergeAgentMcpEvidence(
  snapshot: SessionMcpSnapshot,
  evidence: AgentMcpEvidence[]
): SessionMcpSnapshot {
  const servers = snapshot.servers
    .filter((server) => server.source !== "agent")
    .map((server) => ({ ...server }))
  for (const row of evidence) {
    if (!row.name) continue
    const toolNames = Array.isArray(row.tools)
      ? row.tools.flatMap((tool) => (tool.name ? [tool.name] : []))
      : row.tools && typeof row.tools === "object"
        ? Object.keys(row.tools)
        : undefined
    const auth = row.authStatus?.toLowerCase()
    const status = (row.runtimeStatus ?? row.status)?.toLowerCase()
    const state: SessionMcpServer["state"] =
      auth === "notloggedin" ||
      auth === "unauthenticated" ||
      status === "needs_auth" ||
      status === "authenticationrequired"
        ? "needs_auth"
        : status === "failed" || status === "error" || Boolean(row.toolsError)
          ? "failed"
          : (!("runtimeStatus" in row) && toolNames !== undefined) ||
              status === "ready" ||
              status === "running" ||
              status === "connected"
            ? "available"
            : "unknown"
    // Keep native inventory separate even when the name matches supplied configuration.
    // The protocol inventory carries no session/config fingerprint.
    servers.push({
      name: row.name,
      source: "agent",
      state,
      scope: row.runtimeStatus && snapshot.externalSessionId ? "session" : "agent",
      ...(toolNames ? { toolNames } : {}),
      ...(row.toolsError ? { error: row.toolsError } : {}),
    })
  }
  return { ...snapshot, telemetry: "supported", error: undefined, servers }
}
