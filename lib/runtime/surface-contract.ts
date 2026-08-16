import type { RuntimeSnapshot } from "./operation-availability"
import { resolveOperationAvailability, type OperationAvailability } from "./operation-availability"

export type SurfaceFallback = "full" | "remote" | "read-only" | "explain" | "hidden"
export type SurfaceOfflinePolicy = "local" | "cached-read" | "safe-queue" | "blocked"

export interface SurfaceContract {
  id: string
  route: string
  navigation?: boolean
  operation?: string
  standalone: SurfaceFallback
  companion: SurfaceFallback
  offline: SurfaceOfflinePolicy
}

/**
 * Public top-level surfaces. This is intentionally explicit: adding a new
 * public navigation item without classifying its runtime behavior fails the
 * completeness test instead of silently inheriting a desktop-only heuristic.
 */
export const SURFACE_CONTRACTS = [
  { id: "chat", route: "/", standalone: "full", companion: "remote", offline: "cached-read" },
  // The standalone/paired mode chooser that used to live at `/welcome` is now
  // the first-run flow's welcome step (ADR-0122). Same runtime classification:
  // it must work with no companion and no network, because choosing how the
  // device runs is a precondition for either.
  {
    id: "onboarding",
    route: "/onboarding",
    standalone: "full",
    companion: "full",
    offline: "local",
  },
  { id: "pair", route: "/pair", standalone: "full", companion: "full", offline: "local" },
  { id: "a2ui", route: "/a2ui", standalone: "full", companion: "remote", offline: "cached-read" },
  {
    id: "canvas-join",
    route: "/canvas/join",
    standalone: "full",
    companion: "remote",
    offline: "cached-read",
  },
  {
    id: "integrations",
    route: "/integrations",
    standalone: "full",
    companion: "remote",
    offline: "cached-read",
  },
  {
    id: "remote-sessions",
    route: "/remote-sessions",
    standalone: "hidden",
    companion: "remote",
    offline: "blocked",
  },
  {
    id: "search",
    route: "/search",
    standalone: "full",
    companion: "remote",
    offline: "cached-read",
  },
  {
    id: "settings",
    route: "/settings",
    standalone: "full",
    companion: "remote",
    offline: "cached-read",
  },
  {
    id: "share-view",
    route: "/share/view",
    standalone: "full",
    companion: "full",
    offline: "cached-read",
  },
  { id: "sites", route: "/sites", standalone: "full", companion: "remote", offline: "cached-read" },
  { id: "fleet", route: "/fleet", standalone: "hidden", companion: "remote", offline: "blocked" },
  {
    id: "workflows",
    route: "/workflows",
    navigation: true,
    standalone: "full",
    companion: "remote",
    offline: "cached-read",
  },
  {
    id: "inbox",
    route: "/inbox",
    navigation: true,
    standalone: "full",
    companion: "remote",
    offline: "cached-read",
  },
  {
    id: "twin",
    route: "/twin",
    navigation: true,
    standalone: "full",
    companion: "remote",
    offline: "cached-read",
  },
  {
    id: "discover",
    route: "/discover",
    navigation: true,
    standalone: "full",
    companion: "remote",
    offline: "local",
  },
  {
    id: "templates",
    route: "/templates",
    navigation: true,
    standalone: "full",
    companion: "remote",
    offline: "cached-read",
  },
  {
    id: "skills",
    route: "/skills",
    navigation: true,
    standalone: "full",
    companion: "remote",
    offline: "cached-read",
  },
  {
    id: "plugins",
    route: "/plugins",
    navigation: true,
    standalone: "full",
    companion: "remote",
    offline: "cached-read",
  },
  {
    id: "agent-teams",
    route: "/agent-teams",
    navigation: true,
    standalone: "full",
    companion: "remote",
    offline: "cached-read",
  },
  {
    id: "scheduler",
    route: "/scheduler",
    navigation: true,
    standalone: "full",
    companion: "remote",
    offline: "cached-read",
  },
  {
    id: "goals",
    route: "/goals",
    navigation: true,
    standalone: "full",
    companion: "remote",
    offline: "cached-read",
  },
  {
    id: "pet",
    route: "/pet",
    navigation: true,
    standalone: "full",
    companion: "remote",
    offline: "local",
  },
  {
    id: "browser",
    route: "/browser",
    navigation: true,
    operation: "browser_session_ensure",
    standalone: "hidden",
    companion: "remote",
    offline: "blocked",
  },
  {
    id: "source-control",
    route: "/source-control",
    navigation: true,
    operation: "git_status",
    standalone: "hidden",
    companion: "remote",
    offline: "cached-read",
  },
  {
    id: "agent-runs",
    route: "/agent-runs",
    navigation: true,
    standalone: "read-only",
    companion: "remote",
    offline: "cached-read",
  },
  {
    id: "issue-projects",
    route: "/projects",
    navigation: true,
    standalone: "full",
    companion: "remote",
    offline: "cached-read",
  },
  {
    id: "workspace",
    route: "/workspace",
    navigation: true,
    standalone: "full",
    companion: "remote",
    offline: "cached-read",
  },
  {
    id: "issues",
    route: "/issues",
    navigation: true,
    standalone: "full",
    companion: "remote",
    offline: "cached-read",
  },
  {
    id: "memory",
    route: "/memory",
    navigation: true,
    standalone: "full",
    companion: "remote",
    offline: "cached-read",
  },
  {
    id: "observability",
    route: "/observability",
    navigation: true,
    standalone: "read-only",
    companion: "remote",
    offline: "cached-read",
  },
  {
    id: "servers",
    route: "/servers",
    navigation: true,
    standalone: "full",
    companion: "full",
    offline: "cached-read",
  },
  {
    // Developer-mode only (ADR-0117). Deliberately not `navigation: true`: the
    // rail is the same for every user, and Creator is gated on a per-user
    // setting, so its entry point is the devtools panel behind the same gate.
    id: "creator",
    route: "/creator",
    standalone: "full",
    companion: "remote",
    offline: "local",
  },
  {
    id: "eval",
    route: "/eval",
    navigation: true,
    standalone: "full",
    companion: "remote",
    offline: "cached-read",
  },
  {
    id: "performance",
    route: "/performance",
    navigation: true,
    operation: "claude_sidecar_status",
    standalone: "hidden",
    companion: "remote",
    offline: "cached-read",
  },
  {
    id: "logs",
    route: "/logs",
    navigation: true,
    standalone: "read-only",
    companion: "remote",
    offline: "cached-read",
  },
  {
    id: "me",
    route: "/me",
    navigation: true,
    standalone: "full",
    companion: "remote",
    offline: "local",
  },
] as const satisfies readonly SurfaceContract[]

export const INTERNAL_ROUTE_EXEMPTIONS = [
  "/deep-link",
  "/e2e/plugin-ui-surfaces",
  "/island",
  "/lark/entry",
  "/lark/shortcut",
  "/pet-overlay",
  "/pet-popup",
  "/plugin-auth/callback",
  "/selection-toolbar",
  "/share-target",
  "/tray-panel",
] as const

const CONTRACT_BY_ID = new Map<string, SurfaceContract>(
  SURFACE_CONTRACTS.map((contract) => [contract.id, contract])
)

export function getSurfaceContract(id: string): SurfaceContract | null {
  return CONTRACT_BY_ID.get(id) ?? null
}

export function getSurfaceContractForRoute(route: string): SurfaceContract | null {
  const normalized = normalizeRoute(route)
  return (
    [...SURFACE_CONTRACTS]
      .sort((a, b) => b.route.length - a.route.length)
      .find((contract) => routeMatches(normalized, contract.route)) ?? null
  )
}

export function isInternalRouteExempt(route: string): boolean {
  return (INTERNAL_ROUTE_EXEMPTIONS as readonly string[]).includes(normalizeRoute(route))
}

export function shouldShowSurface(contract: SurfaceContract, snapshot: RuntimeSnapshot): boolean {
  if (!snapshot.target) return true
  if (snapshot.target.kind === "legacy-readonly") {
    return contract.offline === "cached-read" || contract.standalone === "read-only"
  }
  if (snapshot.target.kind === "standalone") {
    return contract.standalone !== "hidden"
  }
  if (!contract.operation) return contract.companion !== "hidden"
  const availability = resolveOperationAvailability({
    command: contract.operation,
    snapshot,
    readOnlyFallback: contract.offline === "cached-read",
    offlineQueueAllowed: contract.offline === "safe-queue",
  })
  return availability.state === "available" || availability.state === "read-only"
}

export function resolveSurfaceAvailability(
  contract: SurfaceContract,
  snapshot: RuntimeSnapshot
): OperationAvailability {
  if (contract.operation) {
    return resolveOperationAvailability({
      command: contract.operation,
      snapshot,
      localExecutorAvailable:
        snapshot.target?.kind === "standalone" && contract.standalone === "full",
      readOnlyFallback: contract.standalone === "read-only" || contract.offline === "cached-read",
      offlineQueueAllowed: contract.offline === "safe-queue",
    })
  }
  const target = snapshot.target
  if (!target) return { state: "available", reason: "local-host" }
  if (target.kind === "legacy-readonly") {
    return contract.offline === "cached-read" || contract.standalone === "read-only"
      ? { state: "read-only", reason: "legacy-readonly" }
      : { state: "unsupported", reason: "legacy-readonly" }
  }
  if (target.kind === "standalone") {
    if (contract.standalone === "hidden" || contract.standalone === "remote") {
      return { state: "unsupported", reason: "requires-companion" }
    }
    return contract.standalone === "read-only"
      ? { state: "read-only", reason: "operation-unavailable" }
      : { state: "available", reason: "local-executor" }
  }
  if (snapshot.vaultState === "locked") {
    return { state: "requires-unlock", reason: "vault-locked" }
  }
  if (snapshot.vaultState === "unavailable") {
    return { state: "requires-pairing", reason: "companion-not-paired" }
  }
  if (snapshot.host && !snapshot.host.compatible) {
    return { state: "incompatible", reason: "host-protocol" }
  }
  if (snapshot.connectionState !== "online") {
    return contract.offline === "cached-read"
      ? { state: "read-only", reason: "offline-cache" }
      : { state: "offline", reason: "connection-offline" }
  }
  return { state: "available", reason: "local-host" }
}

function normalizeRoute(route: string): string {
  const pathname = route.split(/[?#]/, 1)[0] || "/"
  if (pathname === "/") return pathname
  return pathname.replace(/\/+$/, "")
}

function routeMatches(route: string, contractRoute: string): boolean {
  if (contractRoute === "/") return route === "/"
  return route === contractRoute || route.startsWith(`${contractRoute}/`)
}
