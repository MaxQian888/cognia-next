/**
 * Inbox write routing (ADR-0131 cross-shell inbox relay, Slice 2.1).
 *
 * Every Inbox reply / draft / override control calls the shell-agnostic
 * `lib/connectors/inbox-writes` facade; THIS module decides where the write
 * executes, so no component branches on `isTauri()` / platform again:
 *
 *   route        | when                                                    | executes
 *   -------------|---------------------------------------------------------|---------------------------
 *   "remote"     | desktop driving a remote host (`isRemoteHostActive()`)  | durable `mobileOutboundQueue`
 *                |                                                         | → RPC on the paired host
 *   "local"      | this shell owns a connector runtime                     | `local.ts` against this Dexie
 *                | (`hasCapability("connector-runtime")` — tauri, headless)|
 *   "remote"     | a companion target is active (mobile paired / web with  | durable queue → RPC
 *                | a `NEXT_PUBLIC_COGNIA_SERVER_URL` / paired host)        |
 *   "unavailable"| standalone browser / mobile-standalone / no target      | throw `InboxWriteUnavailableError`;
 *                |                                                         | Inbox shows `StateCard.RequiresHost`
 *
 * Order matters: a desktop that is driving a remote host must NOT fall into
 * `"local"` even though its baseline still lists `connector-runtime` — its
 * local runtime is torn down while the remote is active
 * (`components/connectors/connector-bus-provider.tsx`).
 */

import { activeHostFeatureManifest } from "@/stores/remote-host/remote-host-store"
import { hasCapability } from "@/lib/platform/capabilities"
import type { HostFeatureManifest } from "@/lib/platform/host-feature-manifest"
import { supportsHostFeatureOperation } from "@/lib/platform/host-feature-manifest"
import {
  resolveOperationAvailability,
  type OperationAvailability,
} from "@/lib/runtime/operation-availability"
import { getRuntimeSnapshot } from "@/lib/runtime/runtime-snapshot-store"
import { isRemoteHostActive } from "@/lib/tauri/transport-routing"

export type InboxWriteRoute = "local" | "remote" | "unavailable"

/** The RPC each relayed write travels as; local writes never leave the process. */
export const INBOX_WRITE_COMMANDS = Object.freeze({
  send: "connector_enqueue_outbound",
  approve: "connector_approve_draft",
  reject: "connector_reject_draft",
  override: "conversation_overrides_update",
} as const)

export type InboxWriteCommand = (typeof INBOX_WRITE_COMMANDS)[keyof typeof INBOX_WRITE_COMMANDS]

/** Host feature that groups the relay operations (`lib/platform/host-feature-manifest.ts`). */
export const INBOX_RELAY_FEATURE = "connectors.inbox-relay" as const

/** Injectable seams so the route matrix is testable without shell globals. */
export interface InboxWriteRouteDeps {
  isRemoteHostActive: () => boolean
  hasConnectorRuntime: () => boolean
  getRuntimeSnapshot: typeof getRuntimeSnapshot
  activeHostFeatureManifest: () => HostFeatureManifest | null
}

const defaultDeps: InboxWriteRouteDeps = {
  isRemoteHostActive,
  hasConnectorRuntime: () => hasCapability("connector-runtime"),
  getRuntimeSnapshot,
  activeHostFeatureManifest,
}

let deps: InboxWriteRouteDeps = defaultDeps

/** Test seam — returns a restore function. */
export function __setInboxWriteRouteDepsForTests(next: Partial<InboxWriteRouteDeps>): () => void {
  const previous = deps
  deps = { ...deps, ...next }
  return () => {
    deps = previous
  }
}

export function resolveInboxWriteRoute(): InboxWriteRoute {
  if (deps.isRemoteHostActive()) return "remote"
  if (deps.hasConnectorRuntime()) return "local"
  if (deps.getRuntimeSnapshot().target?.kind === "companion") return "remote"
  return "unavailable"
}

/**
 * Operations the ACTIVE remote host advertises as implemented + healthy, or
 * `null` when no remote host is being driven / its manifest is not ready.
 * Desktop-only: mobile / web companions carry the same facts in
 * `getRuntimeSnapshot().host.operations`.
 */
export function remoteHostOperations(): readonly string[] | null {
  if (!deps.isRemoteHostActive()) return null
  const manifest = deps.activeHostFeatureManifest()
  if (!manifest) return null
  if (manifest.schemaVersion === 1) {
    return Object.values(manifest.features).flatMap((descriptor) => descriptor?.operations ?? [])
  }
  return manifest.operations.filter((operation) => operation.healthy).map((op) => op.name)
}

/**
 * Availability of ONE relay command on the current route. Wraps
 * `resolveOperationAvailability` for companion targets and consults the
 * active remote host's feature manifest on the desktop.
 */
export function resolveInboxWriteAvailability(command: InboxWriteCommand): OperationAvailability {
  const route = resolveInboxWriteRoute()
  if (route === "local") return { state: "available", reason: "local-host" }
  if (route === "unavailable") return { state: "unsupported", reason: "requires-companion" }
  if (deps.isRemoteHostActive()) {
    const manifest = deps.activeHostFeatureManifest()
    if (!manifest) return { state: "incompatible", reason: "host-manifest-missing" }
    return supportsHostFeatureOperation(manifest, INBOX_RELAY_FEATURE, command)
      ? { state: "available", reason: "local-host" }
      : { state: "unsupported", reason: "operation-unavailable" }
  }
  return resolveOperationAvailability({
    snapshot: deps.getRuntimeSnapshot(),
    command,
    localExecutorAvailable: false,
    readOnlyFallback: false,
    // Relay writes ride the durable queue and are idempotent by contract.
    offlineQueueAllowed: true,
  })
}

/** Availability states under which a relayed write may be enqueued. */
const ENQUEUEABLE_STATES: ReadonlySet<OperationAvailability["state"]> = new Set([
  "available",
  "queued",
  // The durable queue replays once the connection returns; the host has
  // already been proven compatible for this to be the reason.
  "offline",
])

export function canEnqueueInboxWrite(availability: OperationAvailability): boolean {
  return ENQUEUEABLE_STATES.has(availability.state)
}

/**
 * Feature gate (Slice 2.5): does the host this thin client talks to ship
 * the ADR-0131 relay at all? Desktop-driving-remote reads the active host's
 * manifest; companion targets read the negotiated runtime snapshot; a local
 * connector host is trivially `true`; standalone is `false`.
 */
export function hostSupportsInboxRelay(): boolean {
  const route = resolveInboxWriteRoute()
  if (route === "local") return true
  if (route === "unavailable") return false
  if (deps.isRemoteHostActive()) {
    return supportsHostFeatureOperation(deps.activeHostFeatureManifest(), INBOX_RELAY_FEATURE)
  }
  const host = deps.getRuntimeSnapshot().host
  return host?.compatible === true && host.operations.includes(INBOX_WRITE_COMMANDS.send)
}
