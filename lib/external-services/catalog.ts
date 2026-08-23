import type { ExternalCapability } from "@/types/external-service"
import type { PluginServiceDef } from "@/types/plugin/plugin-service"

export interface RegisteredExternalService {
  pluginId: string
  definition: PluginServiceDef
}

interface CapabilityFilter {
  pluginId?: string
  serviceId?: string
  providerId?: string
  surface?: ExternalCapability["surfaces"][number]
  operationId?: string
}

const services = new Map<string, RegisteredExternalService>()
const capabilities = new Map<string, ExternalCapability>()
const listeners = new Set<() => void>()
let revision = 0

function serviceKey(pluginId: string, serviceId: string): string {
  return `${pluginId}:${serviceId}`
}

function capabilityKey(capability: ExternalCapability): string {
  return `${capability.pluginId}:${capability.serviceId}:${capability.providerId}:${capability.capabilityId}`
}

function emitChange(): void {
  revision += 1
  for (const listener of listeners) listener()
}

export function registerExternalServices(pluginId: string, definitions: PluginServiceDef[]): void {
  for (const definition of definitions) {
    const providerIds = new Set<string>()
    for (const provider of definition.providers) {
      if (providerIds.has(provider.id)) {
        throw new Error(
          `External service "${definition.id}" has duplicate provider "${provider.id}"`
        )
      }
      providerIds.add(provider.id)
    }
    services.set(serviceKey(pluginId, definition.id), { pluginId, definition })
  }
  if (definitions.length > 0) emitChange()
}

export function registerExternalCapabilities(
  pluginId: string,
  serviceId: string,
  providerId: string,
  entries: ExternalCapability[]
): void {
  const service = services.get(serviceKey(pluginId, serviceId))
  if (!service) throw new Error(`External service "${pluginId}:${serviceId}" is not registered`)
  if (!service.definition.providers.some((provider) => provider.id === providerId)) {
    throw new Error(`External service "${serviceId}" has no provider "${providerId}"`)
  }
  for (const entry of entries) {
    if (
      entry.pluginId !== pluginId ||
      entry.serviceId !== serviceId ||
      entry.providerId !== providerId
    ) {
      throw new Error("External capability identity does not match its registration scope")
    }
    capabilities.set(capabilityKey(entry), entry)
  }
  if (entries.length > 0) emitChange()
}

export function getExternalService(
  pluginId: string,
  serviceId: string
): RegisteredExternalService | undefined {
  return services.get(serviceKey(pluginId, serviceId))
}

export function listExternalServices(pluginId?: string): RegisteredExternalService[] {
  return [...services.values()].filter((service) => !pluginId || service.pluginId === pluginId)
}

export function listExternalCapabilities(filter: CapabilityFilter = {}): ExternalCapability[] {
  return [...capabilities.values()].filter(
    (entry) =>
      (!filter.pluginId || entry.pluginId === filter.pluginId) &&
      (!filter.serviceId || entry.serviceId === filter.serviceId) &&
      (!filter.providerId || entry.providerId === filter.providerId) &&
      (!filter.surface || entry.surfaces.includes(filter.surface)) &&
      (!filter.operationId || entry.operationId === filter.operationId)
  )
}

export function unregisterExternalServicesByPlugin(pluginId: string): number {
  let removed = 0
  for (const [key, service] of services) {
    if (service.pluginId !== pluginId) continue
    services.delete(key)
    removed += 1
  }
  for (const [key, capability] of capabilities) {
    if (capability.pluginId === pluginId) capabilities.delete(key)
  }
  if (removed > 0) emitChange()
  return removed
}

export function getExternalServiceCatalogRevision(): number {
  return revision
}

export function subscribeExternalServiceCatalog(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function __resetExternalServiceCatalogForTesting(): void {
  services.clear()
  capabilities.clear()
  listeners.clear()
  revision = 0
}
