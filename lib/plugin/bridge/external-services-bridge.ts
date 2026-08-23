import type { ExternalCapability } from "@/types/external-service"
import type { PluginManifest } from "@/types/plugin"
import type { ServiceProviderRef } from "@/types/plugin/plugin-service"

import {
  registerExternalCapabilities,
  registerExternalServices,
  unregisterExternalServicesByPlugin,
} from "@/lib/external-services/catalog"
import { unregisterManagedMcpChatSurfacesByPlugin } from "@/lib/external-services/providers/mcp-chat"

function assertContribution(
  manifest: PluginManifest,
  serviceId: string,
  provider: ServiceProviderRef
): void {
  const exists =
    provider.kind === "mcp"
      ? manifest.mcpServerPresets?.some((entry) => entry.id === provider.contributionId)
      : provider.kind === "integration"
        ? manifest.integrations?.some((entry) => entry.id === provider.contributionId)
        : provider.kind === "openapi"
          ? manifest.openApiProviders?.some((entry) => entry.id === provider.contributionId)
          : manifest.browserSiteProviders?.some((entry) => entry.id === provider.contributionId)

  if (!exists) {
    throw new Error(
      `External service "${serviceId}" provider "${provider.id}" references missing ${provider.kind} contribution "${provider.contributionId}"`
    )
  }
}

function integrationCapabilities(
  pluginId: string,
  serviceId: string,
  provider: ServiceProviderRef,
  manifest: PluginManifest
): ExternalCapability[] {
  const integration = manifest.integrations?.find((entry) => entry.id === provider.contributionId)
  if (!integration) return []
  const capabilities: ExternalCapability[] = integration.actions.map((action) => ({
    pluginId,
    serviceId,
    providerId: provider.id,
    capabilityId: action.id,
    operationId: action.operationId ?? `${integration.id}.${action.id}`,
    kind: "action",
    risk: action.risk,
    inputSchema: action.inputSchema,
    outputSchema: action.outputSchema,
    scopeSelectors: action.scopeSelectors,
    surfaces: provider.surfaces,
  }))
  for (const kind of integration.resourceKinds) {
    capabilities.push({
      pluginId,
      serviceId,
      providerId: provider.id,
      capabilityId: `resource:${kind}`,
      kind: "resource",
      risk: "read",
      surfaces: provider.surfaces,
    })
  }
  for (const event of integration.eventTypes) {
    capabilities.push({
      pluginId,
      serviceId,
      providerId: provider.id,
      capabilityId: `event:${event.id}`,
      kind: "event",
      risk: "read",
      inputSchema: event.payloadSchema,
      surfaces: provider.surfaces,
    })
  }
  return capabilities
}

function browserCapabilities(
  pluginId: string,
  serviceId: string,
  provider: ServiceProviderRef,
  manifest: PluginManifest
): ExternalCapability[] {
  const browser = manifest.browserSiteProviders?.find(
    (entry) => entry.id === provider.contributionId
  )
  return (browser?.operations ?? []).map((operation) => ({
    pluginId,
    serviceId,
    providerId: provider.id,
    capabilityId: operation.id,
    operationId: operation.operationId,
    kind: "action",
    risk: operation.risk,
    inputSchema: operation.inputSchema,
    surfaces: provider.surfaces,
  }))
}

export function registerExternalServicesForPlugin(
  pluginId: string,
  manifest: PluginManifest
): void {
  const services =
    manifest.services ??
    (manifest.integrations ?? []).map((integration) => ({
      id: integration.id,
      label: integration.label,
      description: integration.description,
      fallbackPolicy: "confirm" as const,
      providers: [
        {
          id: "integration",
          kind: "integration" as const,
          contributionId: integration.id,
          priority: 100,
          surfaces: ["chat", "workflow", "inbox"] as const,
        },
      ],
    }))
  if (services.length === 0) return
  unregisterManagedMcpChatSurfacesByPlugin(pluginId)
  unregisterExternalServicesByPlugin(pluginId)
  try {
    for (const service of services) {
      for (const provider of service.providers) assertContribution(manifest, service.id, provider)
    }
    registerExternalServices(pluginId, services)
    for (const service of services) {
      for (const provider of service.providers) {
        const capabilities =
          provider.kind === "integration"
            ? integrationCapabilities(pluginId, service.id, provider, manifest)
            : provider.kind === "browser"
              ? browserCapabilities(pluginId, service.id, provider, manifest)
              : []
        registerExternalCapabilities(pluginId, service.id, provider.id, capabilities)
      }
    }
  } catch (error) {
    unregisterExternalServicesByPlugin(pluginId)
    throw error
  }
}

export function unregisterExternalServicesForPlugin(pluginId: string): number {
  unregisterManagedMcpChatSurfacesByPlugin(pluginId)
  return unregisterExternalServicesByPlugin(pluginId)
}
