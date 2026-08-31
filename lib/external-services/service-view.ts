/**
 * One row per SERVICE, with its providers and their connection state merged.
 *
 * The settings section used to render two disjoint lists and, between them,
 * lose the only thing a user came to do. "Available services" filtered out any
 * service that already had a connection row, and
 * `reconcilePluginExternalServiceConnections` creates one connection per MCP
 * provider the moment the owning plugin is enabled. So a bundled service like
 * Figma was never "available": it appeared only in the connections list, as
 * two rows reading "Figma Remote / pending" whose sole control was Pause.
 * Nothing said what "pending" was waiting for, and nothing led to the managed
 * MCP server that was sitting there disabled and unreviewed.
 *
 * That server is disabled and untrusted ON PURPOSE (see `lifecycle.ts`, and
 * `reviewMcpServer`, which records trust without enabling anything). The fix
 * is therefore not a one-click Connect button. It is to say what the state is
 * and hand the user the review, which already exists in the MCP section.
 *
 * Shape follows the pattern the industry has converged on: one entry per
 * service, and the choice of HOW to connect (remote MCP, local MCP, browser
 * profile) is a child of it rather than a sibling in a flat list.
 *
 * Pure, so the section can render from it and tests can drive every state
 * without a database.
 */

import type {
  ExternalServiceSurface,
  ServiceConnection,
  ServiceConnectionStatus,
} from "@/types/external-service"
import type {
  PluginServiceDef,
  ServiceProviderAvailability,
  ServiceProviderKind,
} from "@/types/plugin/plugin-service"
import type { RegisteredExternalService } from "./catalog"

/** `not-connected` is not a `ServiceConnectionStatus`: no row exists yet. */
export type ServiceProviderState = ServiceConnectionStatus | "not-connected"

/**
 * The one thing this provider is waiting on. Rendered as the row's primary
 * button, so a state with nothing to do must say so rather than borrow an
 * action from a neighbouring state.
 */
export type ServiceProviderAction =
  /**
   * A managed MCP server exists but has not been reviewed. This is the state
   * every bundled MCP service starts in.
   */
  | { kind: "review"; serverId: string }
  /** Reviewed and in use. The row leads to its server for tools and logs. */
  | { kind: "manage"; serverId: string }
  /** The user paused it here. */
  | { kind: "resume" }
  /**
   * The vendor has not admitted us yet (`availability: "vendor-pending"`).
   * Terminal from the user's side, and saying so beats a button that fails.
   */
  | { kind: "blocked-upstream" }
  /** Nothing has been provisioned and nothing here can provision it. */
  | { kind: "none" }

export interface ServiceProviderView {
  providerId: string
  kind: ServiceProviderKind
  availability: ServiceProviderAvailability
  surfaces: readonly ExternalServiceSurface[]
  /** Ordering hint from the manifest. Higher runs first. */
  priority: number
  connection: ServiceConnection | null
  state: ServiceProviderState
  action: ServiceProviderAction
}

export interface ServiceView {
  /** `${pluginId}:${serviceId}`, the stable React key and lookup id. */
  key: string
  pluginId: string
  serviceId: string
  label: string
  description?: string
  icon?: string
  skillIds: readonly string[]
  providers: readonly ServiceProviderView[]
  /**
   * Whether ANY provider of this service is usable right now. Drives the card
   * badge, because "Figma is connected" is true as soon as one of its two
   * interchangeable providers is.
   */
  connected: boolean
  /** True when at least one provider is waiting on a review. */
  awaitingReview: boolean
}

function connectionKey(pluginId: string, serviceId: string, providerId: string): string {
  return `${pluginId} ${serviceId} ${providerId}`
}

function resolveAction(
  availability: ServiceProviderAvailability,
  connection: ServiceConnection | null
): ServiceProviderAction {
  if (!connection) {
    // Nothing provisioned. For a vendor-pending provider that is the expected
    // resting state, and naming the vendor is more use than an empty cell.
    return availability === "vendor-pending" ? { kind: "blocked-upstream" } : { kind: "none" }
  }
  if (connection.status === "suspended") return { kind: "resume" }
  if (connection.providerRef.kind === "mcp") {
    const serverId = connection.providerRef.serverId
    // `pending` on a managed MCP connection means the server it provisioned is
    // still untrusted. That review is the next step, and it lives in the MCP
    // section rather than being duplicated here.
    return connection.status === "pending" || connection.status === "needs-auth"
      ? { kind: "review", serverId }
      : { kind: "manage", serverId }
  }
  return { kind: "none" }
}

/**
 * Merge the catalog with the connection rows.
 *
 * Services keep manifest order. Providers sort by descending priority, which
 * is the order the router would try them in, so the list reads as the
 * fallback chain it actually is.
 */
export function buildServiceViews(
  services: readonly RegisteredExternalService[],
  connections: readonly ServiceConnection[]
): ServiceView[] {
  const byProvider = new Map<string, ServiceConnection>()
  for (const connection of connections) {
    if (!connection.pluginId) continue
    byProvider.set(
      connectionKey(connection.pluginId, connection.serviceId, connection.providerId),
      connection
    )
  }

  return services.map(({ pluginId, definition }) => {
    const providers = [...definition.providers]
      .sort((a, b) => b.priority - a.priority)
      .map<ServiceProviderView>((provider) => {
        const connection =
          byProvider.get(connectionKey(pluginId, definition.id, provider.id)) ?? null
        const availability = provider.availability ?? "supported"
        return {
          providerId: provider.id,
          kind: provider.kind,
          availability,
          surfaces: provider.surfaces,
          priority: provider.priority,
          connection,
          state: connection?.status ?? "not-connected",
          action: resolveAction(availability, connection),
        }
      })

    return {
      key: `${pluginId}:${definition.id}`,
      pluginId,
      serviceId: definition.id,
      label: definition.label,
      description: definition.description,
      icon: definition.icon,
      skillIds: definition.skillIds ?? [],
      providers,
      connected: providers.some((provider) => provider.state === "connected"),
      awaitingReview: providers.some((provider) => provider.action.kind === "review"),
    } satisfies ServiceView
  })
}

/**
 * Connections with no catalog service behind them.
 *
 * A website the user connected by hand has no `PluginServiceDef`, so it would
 * vanish from a purely catalog-driven render. Anything whose owning plugin was
 * uninstalled while its rows survived lands here too, which is the only place
 * it can be seen and cleaned up.
 */
export function orphanServiceConnections(
  services: readonly RegisteredExternalService[],
  connections: readonly ServiceConnection[]
): ServiceConnection[] {
  const known = new Set<string>()
  for (const { pluginId, definition } of services) {
    for (const provider of definition.providers) {
      known.add(connectionKey(pluginId, definition.id, provider.id))
    }
  }
  return connections.filter(
    (connection) =>
      !connection.pluginId ||
      !known.has(connectionKey(connection.pluginId, connection.serviceId, connection.providerId))
  )
}

/** Re-exported so the section imports one module rather than three. */
export type { PluginServiceDef }
