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
  {
    id: "a2ui",
    route: "/a2ui",
    navigation: true,
    standalone: "full",
    companion: "remote",
    offline: "cached-read",
  },
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
  {
    id: "sites",
    route: "/sites",
    navigation: true,
    standalone: "full",
    companion: "remote",
    offline: "cached-read",
  },
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
    // Reads work standalone (the mirror is local), but every WRITE needs a
    // connector runtime this shell does not have — see
    // {@link standaloneInboxRequiresHost}.
    standalone: "explain",
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
    id: "squads",
    route: "/squads",
    navigation: true,
    standalone: "full",
    companion: "remote",
    offline: "cached-read",
  },
  {
    // The page `/squads` replaces. Still routable, and still declared, until
    // its own removal lands — an undeclared route is treated as unavailable,
    // which would break it for anyone holding a link.
    id: "agent-teams",
    route: "/agent-teams",
    navigation: false,
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
    id: "servers",
    route: "/servers",
    navigation: true,
    standalone: "full",
    companion: "full",
    offline: "cached-read",
  },
  {
    id: "devices",
    route: "/devices",
    navigation: true,
    // A standalone browser with nothing paired still has one device to
    // describe (itself), and, since the console grew an in-place add-host
    // sheet, it also has the one action that ends the standalone state. That
    // makes this "full" rather than "explain": the surface is not a degraded
    // fleet view here, it is the way out of having no fleet. The empty half is
    // still stated by the console's own standalone alert.
    standalone: "full",
    companion: "remote",
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

/**
 * ADR-0131 §2.2 — a standalone browser tab or an unpaired phone can READ the
 * Inbox (its Dexie mirror is local) but can never WRITE to it: replying,
 * approving a draft, or flipping an override all require a connector runtime,
 * and no browser or phone runs adapters.
 *
 * This is intentional and permanent, not a gap to close, so it is documented
 * on all three axes required by CLAUDE.md rule 7:
 *
 *  1. **Type** — the `inbox` contract above is `standalone: "explain"`, and
 *     this constant carries the reason.
 *  2. **UI** — `components/inbox/state/state-card.tsx:StateCard.RequiresHost`
 *     is rendered by `components/inbox/inbox-shell.tsx` whenever
 *     `resolveInboxWriteRoute()` is `"unavailable"`, pointing the user at
 *     `/pair` rather than showing an empty list.
 *  3. **Test** — pinned by `components/inbox/inbox-shell.test.tsx` and
 *     `lib/runtime/surface-contract.test.ts`.
 *
 * Pairing to a host (or running the desktop app) lifts it: the write route
 * becomes `"remote"` / `"local"` and every control works again.
 */
export const standaloneInboxRequiresHost = {
  surfaceId: "inbox",
  reason: "connector-runtime-absent",
  remedy: "/pair",
} as const

/**
 * `/devices` in standalone: the console still has one honest row — this
 * machine — but no fleet and no host to ask.
 *
 * `standalone: "explain"` is a convention each surface implements for itself;
 * `resolveSurfaceAvailability` has no generic branch for it. Unlike
 * {@link standaloneInboxRequiresHost}, this one does NOT swap the shell out:
 * the local device's capabilities and sandbox tiers are real and worth
 * reading. What it explains is the half that is missing — paired devices,
 * remote hosts, and every host-authoritative fact (lifecycle state, the exact
 * capabilities behind a grant) that `companion_list_devices` would supply.
 *
 * Rendered by `components/devices/device-console.tsx` and pinned by its test.
 */
export const standaloneDevicesRequiresHost = {
  surfaceId: "devices",
  reason: "no-paired-host",
  remedy: "/pair",
} as const

export const INTERNAL_ROUTE_EXEMPTIONS = [
  "/deep-link",
  "/e2e/plugin-ui-surfaces",
  "/island",
  "/lark/entry",
  "/lark/shortcut",
  // Same category as `/plugin-auth/callback`: an identity-provider return leg
  // that hands off and navigates away, with no runtime of its own to classify.
  "/logto/callback",
  "/pet-overlay",
  "/pet-popup",
  "/plugin-auth/callback",
  // An unauthenticated end-user portal for a published workflow app. Its API
  // origin comes from the `?api=` query parameter, so it boots no account, no
  // runtime target and no transport — the same category as `/status`. There is
  // no runtime here to classify, and its reachability tracks the `?api=` host
  // rather than this app's connection state.
  "/portal",
  // The skill recorder's always-on-top controller strip, opened only by
  // `src-tauri/src/recorder_window/mod.rs` at `WebviewUrl::App`. Nothing
  // navigates here. Same category as `/selection-toolbar` and `/tray-panel`,
  // and a contract could not bind anyway: `resolveRuntimeTarget` returns null
  // on Tauri, so the boundary short-circuits on `!snapshot.target` in the only
  // shell that ever opens this window.
  "/recorder-controller",
  "/selection-toolbar",
  "/share-target",
  // A public, read-only document served by the lightweight route shell — it
  // deliberately boots no account, no target and no transport.
  "/status",
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
  // Read the contract's own companion column before consulting the host.
  //
  // Everything below this point asks about the *host* — is the vault open, is
  // the manifest compatible, are we online. A surface declared `companion:
  // "full"` with `offline: "local"` answers none of those questions: it runs in
  // this client and needs nothing else, which is exactly `/pair` and
  // `/onboarding` — how a companion acquires a host in the first place. Gating
  // them on having one walls off the only exits, and the remedy for
  // `requires-pairing` is a link to `/pair` — so the page that fixes the state
  // was refusing to render for exactly the state it fixes.
  //
  // `offline: "local"` is what narrows the exemption, and it has to. `companion:
  // "full"` on its own also covers `/servers` and `/share/view`, which declare
  // `offline: "cached-read"` precisely BECAUSE they depend on the host — the
  // Ops Controller's credentials come out of the vault. Exempting those
  // reported a locked vault and a dead connection as `available`, and made
  // their own `cached-read` column unreachable. They fall through instead.
  if (contract.companion === "hidden") {
    return { state: "unsupported", reason: "operation-unavailable" }
  }
  if (contract.companion === "full" && contract.offline === "local") {
    return { state: "available", reason: "local-executor" }
  }
  if (contract.companion === "read-only") {
    return { state: "read-only", reason: "operation-unavailable" }
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
