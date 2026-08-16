import type { AgentId, McpCapabilityCacheRow, McpSyncJobStatus } from "@cognia/agent-config-types"

import { getDb } from "@/lib/db/schema"
import type { McpAuditLogRow } from "@/types/wiki"

export interface McpServerOperations {
  serverId: string
  displayName: string
  events: number
  failures: number
  failureRate: number
  lastEventAt?: number
  lastFailureAt?: number
  lastErrorCode?: string
  connectP95Ms?: number
  capabilityUpdatedAt?: number
  capabilityExpiresAt?: number
}

export interface McpSyncOperations {
  agentId: AgentId
  status: McpSyncJobStatus
  lagMs: number
  attempts: number
  nextAttemptAt?: number
  errorCode?: "sync-failed"
}

export interface McpOperationsSnapshot {
  generatedAt: number
  servers: McpServerOperations[]
  sync: McpSyncOperations[]
}

function percentile95(values: number[]): number | undefined {
  if (values.length === 0) return undefined
  const ordered = [...values].sort((left, right) => left - right)
  return ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)]
}

function latestCapability(rows: McpCapabilityCacheRow[]): McpCapabilityCacheRow | undefined {
  return rows.reduce<McpCapabilityCacheRow | undefined>(
    (latest, row) => (!latest || row.updatedAt > latest.updatedAt ? row : latest),
    undefined
  )
}

/** Build one redacted operations projection from the existing durable tables. */
export async function loadMcpOperationsSnapshot(now = Date.now()): Promise<McpOperationsSnapshot> {
  const db = getDb()
  const [servers, auditRows, syncJobs, capabilities] = await db.transaction(
    "r",
    [db.mcpServers, db.mcpAuditLog, db.mcpSyncJobs, db.mcpCapabilityCache],
    async () =>
      Promise.all([
        db.mcpServers.toArray(),
        db.mcpAuditLog.filter((row) => row.direction === "outbound").toArray(),
        db.mcpSyncJobs.toArray(),
        db.mcpCapabilityCache.toArray(),
      ])
  )

  const auditsByServer = new Map<string, McpAuditLogRow[]>()
  for (const row of auditRows) {
    if (!row.serverId || row.phase === "close") continue
    const rows = auditsByServer.get(row.serverId) ?? []
    rows.push(row)
    auditsByServer.set(row.serverId, rows)
  }
  const capabilitiesByServer = new Map<string, McpCapabilityCacheRow[]>()
  for (const row of capabilities) {
    const rows = capabilitiesByServer.get(row.serverId) ?? []
    rows.push(row)
    capabilitiesByServer.set(row.serverId, rows)
  }

  const serverRows = servers
    .map<McpServerOperations>((server) => {
      const events = auditsByServer.get(server.id) ?? []
      const failures = events.filter((row) => Boolean(row.errorCode))
      const lastEvent = events.reduce<McpAuditLogRow | undefined>(
        (latest, row) => (!latest || row.ts > latest.ts ? row : latest),
        undefined
      )
      const lastFailure = failures.reduce<McpAuditLogRow | undefined>(
        (latest, row) => (!latest || row.ts > latest.ts ? row : latest),
        undefined
      )
      const capability = latestCapability(capabilitiesByServer.get(server.id) ?? [])
      return {
        serverId: server.id,
        displayName: server.displayName ?? server.name,
        events: events.length,
        failures: failures.length,
        failureRate: events.length === 0 ? 0 : failures.length / events.length,
        lastEventAt: lastEvent?.ts,
        lastFailureAt: lastFailure?.ts,
        lastErrorCode: lastFailure?.errorCode,
        connectP95Ms: percentile95(
          events
            .filter((row) => row.phase === "connect")
            .map((row) => row.durationMs ?? row.latencyMs)
        ),
        capabilityUpdatedAt: capability?.updatedAt,
        capabilityExpiresAt: capability?.expiresAt,
      }
    })
    .sort((left, right) => left.displayName.localeCompare(right.displayName))

  const sync = syncJobs
    .map<McpSyncOperations>((job) => {
      const active =
        job.status === "pending" || job.status === "running" || job.status === "retrying"
      return {
        agentId: job.id,
        status: job.status,
        lagMs: active ? Math.max(0, now - job.createdAt) : 0,
        attempts: job.attempts,
        nextAttemptAt: job.nextAttemptAt > 0 ? job.nextAttemptAt : undefined,
        errorCode: job.lastError ? "sync-failed" : undefined,
      }
    })
    .sort((left, right) => left.agentId.localeCompare(right.agentId))

  return { generatedAt: now, servers: serverRows, sync }
}
