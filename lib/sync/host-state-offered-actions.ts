/**
 * The HostState intents the paired Host says this caller may submit.
 *
 * A Host answers `host_state_status` with `supportedActions` when it restricts
 * the caller below what its grants imply. Today that is an org member's
 * partition (P5d/P6): steering, approvals and moving a conversation between
 * workspaces are refused there whatever the device holds. Before this store a
 * client never read the answer, so it offered those actions and the Host
 * refused each one after the fact.
 *
 * Recorded per Host scope (`runtimeTargetId`) by every installed HostState
 * sync, counted so a second installer for the same target (the boot provider
 * and the outbound runner both install one) does not lose the answer when the
 * other stops. No record, or a Host that sent no list, means "not restricted":
 * the grants and the Host's own refusal stay the authority, exactly as before.
 */

import type { HostStateIntentKind } from "@cognia/agent-config-types/host-state"
import { getRuntimeSnapshot } from "@/lib/runtime/runtime-snapshot-store"
import { getActiveRuntimeTargetContext } from "@/lib/runtime/runtime-target-context"

interface Offered {
  /** `undefined`: the Host named no restriction. */
  actions: readonly HostStateIntentKind[] | undefined
  installs: number
}

const offered = new Map<string, Offered>()
const listeners = new Set<() => void>()
let version = 0

function changed(): void {
  version += 1
  for (const listener of listeners) listener()
}

/** Record what the Host answered for `runtimeTargetId`; one call per installed sync. */
export function publishOfferedHostStateActions(
  runtimeTargetId: string,
  actions: readonly HostStateIntentKind[] | undefined
): void {
  const current = offered.get(runtimeTargetId)
  offered.set(runtimeTargetId, {
    actions: actions ? [...actions] : undefined,
    installs: (current?.installs ?? 0) + 1,
  })
  changed()
}

/** A later answer from an already-installed sync (a resync re-read the status). */
export function refreshOfferedHostStateActions(
  runtimeTargetId: string,
  actions: readonly HostStateIntentKind[] | undefined
): void {
  const current = offered.get(runtimeTargetId)
  if (!current) return
  const next = actions ? [...actions] : undefined
  if (JSON.stringify(next) === JSON.stringify(current.actions)) return
  offered.set(runtimeTargetId, { ...current, actions: next })
  changed()
}

/** The sync that published for `runtimeTargetId` stopped. */
export function retractOfferedHostStateActions(runtimeTargetId: string): void {
  const current = offered.get(runtimeTargetId)
  if (!current) return
  if (current.installs > 1)
    offered.set(runtimeTargetId, { ...current, installs: current.installs - 1 })
  else offered.delete(runtimeTargetId)
  changed()
}

/**
 * Whether the Host offers `kind` to this caller on `runtimeTargetId`. Unknown
 * (no sync installed, no list sent, no target named) reads as offered.
 */
export function hostStateActionOffered(
  kind: HostStateIntentKind,
  runtimeTargetId: string | null | undefined
): boolean {
  if (!runtimeTargetId) return true
  const actions = offered.get(runtimeTargetId)?.actions
  return actions === undefined || actions.includes(kind)
}

/**
 * The same question for the Host this client is paired to now, addressed the
 * way `enqueueHostStateIntentIfAvailable` addresses it: the scope the Host
 * declared, else this client's own id for the pairing.
 */
export function hostStateActionOfferedHere(kind: HostStateIntentKind): boolean {
  const targetId =
    getRuntimeSnapshot().host?.hostStateScope?.runtimeTargetId ??
    getActiveRuntimeTargetContext()?.targetId
  return hostStateActionOffered(kind, targetId)
}

export function subscribeOfferedHostStateActions(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Changes whenever any recorded answer does; for `useSyncExternalStore`. */
export function offeredHostStateActionsVersion(): number {
  return version
}

/**
 * Thrown by `enqueueHostStateIntentIfAvailable` for an intent the Host has
 * said it will refuse: nothing is queued, so nothing is refused silently later.
 */
export class HostStateActionNotOfferedError extends Error {
  readonly code = "host_state_action_not_offered"
  constructor(readonly kind: HostStateIntentKind) {
    super(`host_state_action_not_offered:${kind}`)
    this.name = "HostStateActionNotOfferedError"
  }
}

export function __resetOfferedHostStateActionsForTesting(): void {
  offered.clear()
  listeners.clear()
  version = 0
}
