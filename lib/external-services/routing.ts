import { getExternalService, listExternalCapabilities } from "./catalog"

export interface ResolveCapabilityRouteInput {
  pluginId: string
  serviceId: string
  operationId: string
  surface: "chat" | "workflow" | "inbox"
  preferredProviderId?: string
  unavailableProviderIds?: string[]
  browserFallbackConfirmed: boolean
}

export type CapabilityRouteResult =
  | { status: "resolved"; providerId: string; capabilityId: string }
  | {
      status: "confirmation-required"
      providerId: string
      capabilityId: string
      reason: "browser-fallback"
    }
  | {
      status: "unavailable"
      reason: "service-not-found" | "no-provider" | "fallback-disabled"
    }

export function resolveCapabilityRoute(input: ResolveCapabilityRouteInput): CapabilityRouteResult {
  const registered = getExternalService(input.pluginId, input.serviceId)
  if (!registered) return { status: "unavailable", reason: "service-not-found" }

  const unavailable = new Set(input.unavailableProviderIds ?? [])
  const providers = registered.definition.providers
    .filter(
      (provider) =>
        provider.surfaces.includes(input.surface) &&
        provider.availability !== "vendor-pending" &&
        !unavailable.has(provider.id)
    )
    .sort((left, right) => {
      if (left.id === input.preferredProviderId) return -1
      if (right.id === input.preferredProviderId) return 1
      return right.priority - left.priority
    })

  for (const provider of providers) {
    const capability = listExternalCapabilities({
      pluginId: input.pluginId,
      serviceId: input.serviceId,
      providerId: provider.id,
      operationId: input.operationId,
      surface: input.surface,
    })[0]
    if (!capability) continue

    if (provider.kind !== "browser" || input.preferredProviderId === provider.id) {
      return {
        status: "resolved",
        providerId: provider.id,
        capabilityId: capability.capabilityId,
      }
    }
    if (registered.definition.fallbackPolicy === "never") {
      return { status: "unavailable", reason: "fallback-disabled" }
    }
    if (!input.browserFallbackConfirmed) {
      return {
        status: "confirmation-required",
        providerId: provider.id,
        capabilityId: capability.capabilityId,
        reason: "browser-fallback",
      }
    }
    return {
      status: "resolved",
      providerId: provider.id,
      capabilityId: capability.capabilityId,
    }
  }

  return { status: "unavailable", reason: "no-provider" }
}
