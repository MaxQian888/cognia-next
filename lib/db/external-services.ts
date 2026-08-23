import type {
  CapabilityGrant,
  OpenApiImportRow,
  ServiceConnection,
  ServiceConnectionStatus,
} from "@/types/external-service"

import { getDb } from "./schema"

function nowIso(): string {
  return new Date().toISOString()
}

function assertConnection(connection: ServiceConnection): void {
  if (!connection.id || !connection.serviceId || !connection.providerId) {
    throw new Error("Service connection identity is incomplete")
  }
  if (!connection.runtimeTargetId || !connection.providerFingerprint) {
    throw new Error("Service connection runtime target and fingerprint are required")
  }
  if (connection.enabledSurfaces.length === 0) {
    throw new Error("Service connection must enable at least one surface")
  }
}

export async function putServiceConnection(
  connection: ServiceConnection
): Promise<ServiceConnection> {
  assertConnection(connection)
  await getDb().serviceConnections.put(connection)
  return connection
}

export async function getServiceConnection(id: string): Promise<ServiceConnection | undefined> {
  return getDb().serviceConnections.get(id)
}

export async function listServiceConnections(
  filter: {
    pluginId?: string
    serviceId?: string
    status?: ServiceConnectionStatus
  } = {}
): Promise<ServiceConnection[]> {
  const rows = await getDb().serviceConnections.toArray()
  return rows
    .filter(
      (row) =>
        (filter.pluginId === undefined || row.pluginId === filter.pluginId) &&
        (filter.serviceId === undefined || row.serviceId === filter.serviceId) &&
        (filter.status === undefined || row.status === filter.status)
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function updateServiceConnectionStatus(
  id: string,
  status: ServiceConnectionStatus
): Promise<ServiceConnection> {
  const existing = await getServiceConnection(id)
  if (!existing) throw new Error(`Service connection "${id}" was not found`)
  const row: ServiceConnection = {
    ...existing,
    status,
    suspendedFromStatus:
      status === "suspended"
        ? existing.status === "suspended"
          ? existing.suspendedFromStatus
          : existing.status
        : undefined,
    updatedAt: nowIso(),
  }
  await getDb().serviceConnections.put(row)
  return row
}

export async function suspendPluginServiceConnections(pluginId: string): Promise<number> {
  const db = getDb()
  const rows = await db.serviceConnections.where("pluginId").equals(pluginId).toArray()
  const active = rows.filter((row) => row.status !== "suspended")
  await db.serviceConnections.bulkPut(
    active.map((row) => ({
      ...row,
      status: "suspended" as const,
      suspendedFromStatus: row.status,
      updatedAt: nowIso(),
    }))
  )
  return active.length
}

export async function resumePluginServiceConnections(pluginId: string): Promise<number> {
  const db = getDb()
  const rows = await db.serviceConnections.where("pluginId").equals(pluginId).toArray()
  const suspended = rows.filter((row) => row.status === "suspended")
  await db.serviceConnections.bulkPut(
    suspended.map(({ suspendedFromStatus, ...row }) => ({
      ...row,
      status: suspendedFromStatus ?? "pending",
      updatedAt: nowIso(),
    }))
  )
  return suspended.length
}

export async function putCapabilityGrant(grant: CapabilityGrant): Promise<CapabilityGrant> {
  if (!grant.id || !grant.connectionId || !grant.providerFingerprint) {
    throw new Error("Capability grant identity is incomplete")
  }
  if (grant.operationPatterns.length === 0) {
    throw new Error("Capability grant requires at least one operation pattern")
  }
  const connection = await getServiceConnection(grant.connectionId)
  if (!connection) throw new Error(`Service connection "${grant.connectionId}" was not found`)
  if (connection.providerFingerprint !== grant.providerFingerprint) {
    throw new Error("Capability grant fingerprint does not match the service connection")
  }
  await getDb().capabilityGrants.put(grant)
  return grant
}

export async function listCapabilityGrants(
  connectionId: string,
  options: { includeExpired?: boolean; now?: string } = {}
): Promise<CapabilityGrant[]> {
  const rows = await getDb().capabilityGrants.where("connectionId").equals(connectionId).toArray()
  const now = options.now ?? nowIso()
  return rows.filter(
    (row) => options.includeExpired || row.expiresAt === undefined || row.expiresAt > now
  )
}

export async function invalidateCapabilityGrants(
  connectionId: string,
  providerFingerprint?: string
): Promise<number> {
  const collection = getDb().capabilityGrants.where("connectionId").equals(connectionId)
  if (!providerFingerprint) return collection.delete()
  return collection.filter((grant) => grant.providerFingerprint !== providerFingerprint).delete()
}

export async function putOpenApiImport(row: OpenApiImportRow): Promise<OpenApiImportRow> {
  if (!row.id || !row.serviceId || !row.providerId || !row.documentFingerprint) {
    throw new Error("OpenAPI import identity is incomplete")
  }
  if (row.document.length > 2 * 1024 * 1024) throw new Error("OpenAPI document exceeds 2 MiB")
  await getDb().openApiImports.put(row)
  return row
}

export async function getOpenApiImport(id: string): Promise<OpenApiImportRow | undefined> {
  return getDb().openApiImports.get(id)
}

export interface RemovedExternalServiceState {
  connectionIds: string[]
  mcpServerIds: string[]
  integrationAccountIds: string[]
  browserProfileIds: string[]
  openApiImportIds: string[]
}

/**
 * Remove all durable control-plane state owned by a plugin. The returned
 * provider references let lifecycle code erase keychain secrets and provider
 * caches after the atomic database deletion succeeds.
 */
export async function removePluginExternalServiceState(
  pluginId: string
): Promise<RemovedExternalServiceState> {
  const db = getDb()
  const connections = await db.serviceConnections.where("pluginId").equals(pluginId).toArray()
  const connectionIds = connections.map((row) => row.id)
  const openApiImports = await db.openApiImports.where("pluginId").equals(pluginId).toArray()
  const mcpServerIds = connections.flatMap((row) =>
    row.providerRef.kind === "mcp" ? [row.providerRef.serverId] : []
  )
  const integrationAccountIds = connections.flatMap((row) =>
    row.providerRef.kind === "integration" ? [row.providerRef.accountId] : []
  )
  const browserProfileIds = connections.flatMap((row) =>
    row.providerRef.kind === "browser" ? [row.providerRef.profileId] : []
  )

  await db.transaction(
    "rw",
    [db.serviceConnections, db.capabilityGrants, db.openApiImports, db.mcpCapabilityCache],
    async () => {
      for (const connectionId of connectionIds) {
        await db.capabilityGrants.where("connectionId").equals(connectionId).delete()
      }
      await db.serviceConnections.bulkDelete(connectionIds)
      await db.openApiImports.bulkDelete(openApiImports.map((row) => row.id))
      for (const serverId of mcpServerIds) {
        await db.mcpCapabilityCache.where("serverId").equals(serverId).delete()
      }
    }
  )
  return {
    connectionIds,
    mcpServerIds,
    integrationAccountIds,
    browserProfileIds,
    openApiImportIds: openApiImports.map((row) => row.id),
  }
}
