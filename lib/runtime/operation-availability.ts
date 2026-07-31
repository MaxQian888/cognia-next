import { getCommandDescriptor } from "@/lib/tauri/command-descriptors"
import type { RuntimeTarget } from "./runtime-target"

export type VaultState = "unavailable" | "locked" | "unlocked"
export type RuntimeConnectionState = "online" | "connecting" | "offline"

export interface HostRuntimeSnapshot {
  /** False when the client and host have no compatible manifest version. */
  compatible: boolean
  /** Exact command operations advertised as implemented and healthy. */
  operations: readonly string[]
  /** Command-manifest capability grants currently held by this device. */
  grants: readonly string[]
}

export interface RuntimeSnapshot {
  target: RuntimeTarget | null
  vaultState: VaultState
  connectionState: RuntimeConnectionState
  host?: HostRuntimeSnapshot
}

export type OperationAvailabilityState =
  | "available"
  | "read-only"
  | "queued"
  | "offline"
  | "requires-unlock"
  | "requires-pairing"
  | "requires-grant"
  | "incompatible"
  | "unsupported"

export type OperationAvailabilityReason =
  | "local-executor"
  | "local-host"
  | "requires-companion"
  | "legacy-readonly"
  | "vault-locked"
  | "companion-not-paired"
  | "host-protocol"
  | "host-manifest-missing"
  | "operation-unavailable"
  | "missing-grant"
  | "offline-cache"
  | "offline-queue"
  | "connection-offline"
  | "service-only"
  | "host-admin-only"
  | "unknown-command"

export interface OperationAvailability {
  state: OperationAvailabilityState
  reason: OperationAvailabilityReason
  requiredGrant?: string
}

export interface ResolveOperationAvailabilityInput {
  snapshot: RuntimeSnapshot
  command: string
  /** A real in-browser/mobile executor exists for this operation. */
  localExecutorAvailable?: boolean
  /** The surface can still render useful cached/local data without mutation. */
  readOnlyFallback?: boolean
  /** Product policy explicitly permits replay after reconnect. */
  offlineQueueAllowed?: boolean
}

/**
 * Resolve one operation without platform-name shortcuts.
 *
 * Command risk, approval, idempotency and transportability come from the
 * shared command manifest. Surfaces provide only facts the manifest cannot
 * know: whether a local executor exists, whether cached read-only rendering is
 * useful, and whether product policy permits offline replay.
 */
export function resolveOperationAvailability(
  input: ResolveOperationAvailabilityInput
): OperationAvailability {
  const descriptor = getCommandDescriptor(input.command)
  if (!descriptor) return { state: "unsupported", reason: "unknown-command" }
  if (descriptor.target === "service") {
    return { state: "unsupported", reason: "service-only" }
  }
  if (descriptor.target === "host-admin") {
    return { state: "unsupported", reason: "host-admin-only" }
  }

  const { target } = input.snapshot

  // Tauri/headless are native execution hosts, represented by no client target.
  if (!target) return { state: "available", reason: "local-host" }

  if (target.kind === "legacy-readonly") {
    return input.readOnlyFallback
      ? { state: "read-only", reason: "legacy-readonly" }
      : { state: "unsupported", reason: "legacy-readonly" }
  }

  if (target.kind === "standalone") {
    return input.localExecutorAvailable
      ? { state: "available", reason: "local-executor" }
      : { state: "unsupported", reason: "requires-companion" }
  }

  if (input.snapshot.vaultState === "locked") {
    return { state: "requires-unlock", reason: "vault-locked" }
  }
  if (input.snapshot.vaultState === "unavailable") {
    return { state: "requires-pairing", reason: "companion-not-paired" }
  }

  const host = input.snapshot.host
  if (!host) return { state: "incompatible", reason: "host-manifest-missing" }
  if (!host.compatible) return { state: "incompatible", reason: "host-protocol" }
  if (!host.operations.includes(input.command)) {
    return input.readOnlyFallback
      ? { state: "read-only", reason: "operation-unavailable" }
      : { state: "unsupported", reason: "operation-unavailable" }
  }
  if (!host.grants.includes(descriptor.capability)) {
    return {
      state: "requires-grant",
      reason: "missing-grant",
      requiredGrant: descriptor.capability,
    }
  }

  if (input.snapshot.connectionState !== "online") {
    if (descriptor.operation === "read" && input.readOnlyFallback) {
      return { state: "read-only", reason: "offline-cache" }
    }
    if (input.offlineQueueAllowed && isSafelyQueueable(descriptor)) {
      return { state: "queued", reason: "offline-queue" }
    }
    return { state: "offline", reason: "connection-offline" }
  }

  return { state: "available", reason: "local-host" }
}

function isSafelyQueueable(
  descriptor: NonNullable<ReturnType<typeof getCommandDescriptor>>
): boolean {
  return (
    descriptor.operation !== "read" &&
    descriptor.risk === "low" &&
    descriptor.approval === "none" &&
    descriptor.idempotency === "required" &&
    descriptor.transports.some(
      (transport) => transport === "http" || transport === "websocket" || transport === "webrtc"
    )
  )
}
