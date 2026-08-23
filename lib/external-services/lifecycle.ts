import type { McpServer } from "@cognia/agent-config-types"

import { deleteBrowserProfile } from "@/lib/db/browser-profiles"
import {
  getServiceConnection,
  invalidateCapabilityGrants,
  putServiceConnection,
  removePluginExternalServiceState,
  resumePluginServiceConnections,
  suspendPluginServiceConnections,
} from "@/lib/db/external-services"
import {
  createMcpServer,
  deleteMcpServer,
  getMcpServer,
  listMcpServersByPlugin,
  updateMcpServer,
} from "@/lib/db/mcp-servers"
import { deleteIntegrationAccount } from "@/lib/integrations/ingress-client"
import { deleteMcpCredentials } from "@/lib/mcp/credentials"
import { sha256Hex } from "@/lib/share/hash"
import type { ServiceConnection } from "@/types/external-service"
import type { PluginManifest, PluginMcpServerPresetDef } from "@/types/plugin"

interface ExternalServiceLifecycleDeps {
  listMcpServersByPlugin: typeof listMcpServersByPlugin
  createMcpServer: typeof createMcpServer
  updateMcpServer: typeof updateMcpServer
  getMcpServer: typeof getMcpServer
  getServiceConnection: typeof getServiceConnection
  putServiceConnection: typeof putServiceConnection
  invalidateCapabilityGrants: typeof invalidateCapabilityGrants
  resumePluginServiceConnections: typeof resumePluginServiceConnections
}

const defaultDeps: ExternalServiceLifecycleDeps = {
  listMcpServersByPlugin,
  createMcpServer,
  updateMcpServer,
  getMcpServer,
  getServiceConnection,
  putServiceConnection,
  invalidateCapabilityGrants,
  resumePluginServiceConnections,
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)])
  )
}

export async function managedMcpPresetFingerprint(input: {
  pluginId: string
  pluginVersion: string
  serviceId: string
  providerId: string
  preset: PluginMcpServerPresetDef
}): Promise<string> {
  return sha256Hex(
    JSON.stringify(
      canonicalize({
        pluginId: input.pluginId,
        pluginVersion: input.pluginVersion,
        serviceId: input.serviceId,
        providerId: input.providerId,
        contributionId: input.preset.id,
        transport: input.preset.transport,
        config: input.preset.config,
        fields: input.preset.fields,
        toolRiskRules: input.preset.toolRiskRules,
      })
    )
  )
}

function managedServerName(pluginId: string, serviceId: string, providerId: string): string {
  return `${pluginId}-${serviceId}-${providerId}`
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
}

function connectionId(pluginId: string, serviceId: string, providerId: string): string {
  return `plugin:${pluginId}:${serviceId}:${providerId}:account`
}

/** Install/update managed MCP definitions without connecting to the service. */
export async function reconcilePluginExternalServiceConnections(
  pluginId: string,
  manifest: PluginManifest,
  deps: ExternalServiceLifecycleDeps = defaultDeps
): Promise<number> {
  const existingServers = await deps.listMcpServersByPlugin(pluginId)
  let reconciled = 0
  for (const service of manifest.services ?? []) {
    for (const provider of service.providers.filter((entry) => entry.kind === "mcp")) {
      const preset = manifest.mcpServerPresets?.find(
        (entry) => entry.id === provider.contributionId
      )
      if (!preset) continue
      const specFingerprint = await managedMcpPresetFingerprint({
        pluginId,
        pluginVersion: manifest.version,
        serviceId: service.id,
        providerId: provider.id,
        preset,
      })
      const managedBy = {
        pluginId,
        serviceId: service.id,
        providerId: provider.id,
        contributionId: provider.contributionId,
        sourceVersion: manifest.version,
        specFingerprint,
      }
      let server = existingServers.find(
        (candidate) =>
          candidate.managedBy?.serviceId === service.id &&
          candidate.managedBy.providerId === provider.id
      )
      const changed = Boolean(server && server.managedBy?.specFingerprint !== specFingerprint)
      if (!server) {
        server = await deps.createMcpServer({
          name: managedServerName(pluginId, service.id, provider.id),
          displayName: preset.name,
          transport: preset.transport,
          config: preset.config as McpServer["config"],
          enabled: false,
          origin: "plugin",
          pluginId,
          trust: { state: "pending" },
          managedBy,
          toolRiskRules: preset.toolRiskRules,
          disallowedTools: preset.defaultDisallowedTools,
        })
      } else if (changed) {
        await deps.updateMcpServer(server.id, {
          displayName: preset.name,
          transport: preset.transport,
          config: preset.config as McpServer["config"],
          enabled: false,
          trust: { state: "pending" },
          origin: "plugin",
          pluginId,
          managedBy,
          toolRiskRules: preset.toolRiskRules,
        })
        server = (await deps.getMcpServer(server.id)) ?? server
      }

      const id = connectionId(pluginId, service.id, provider.id)
      const existing = await deps.getServiceConnection(id)
      const now = new Date().toISOString()
      const row: ServiceConnection = {
        id,
        pluginId,
        serviceId: service.id,
        providerId: provider.id,
        runtimeTargetId: "local",
        accountLabel: preset.name,
        status: changed
          ? "pending"
          : existing?.status === "suspended"
            ? (existing.suspendedFromStatus ?? "pending")
            : (existing?.status ?? "pending"),
        providerFingerprint: specFingerprint,
        providerRef: { kind: "mcp", serverId: server.id },
        enabledSurfaces: existing?.enabledSurfaces ?? provider.surfaces,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }
      await deps.putServiceConnection(row)
      if (changed) await deps.invalidateCapabilityGrants(id, specFingerprint)
      reconciled += 1
    }
  }
  await deps.resumePluginServiceConnections(pluginId)
  return reconciled
}

export async function suspendPluginExternalServices(pluginId: string): Promise<number> {
  return suspendPluginServiceConnections(pluginId)
}

/** Terminal lifecycle cleanup including provider-owned credentials and profiles. */
export async function purgePluginExternalServices(pluginId: string): Promise<void> {
  const removed = await removePluginExternalServiceState(pluginId)
  for (const serverId of removed.mcpServerIds) {
    const server = await getMcpServer(serverId)
    if (server) await deleteMcpCredentials(server)
    await deleteMcpServer(serverId)
  }
  for (const accountId of removed.integrationAccountIds) {
    await deleteIntegrationAccount(pluginId, accountId)
  }
  for (const profileId of removed.browserProfileIds) {
    await deleteBrowserProfile(profileId)
  }
}
