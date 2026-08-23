import {
  HOST_PROTOCOL_MAX_VERSION,
  HOST_PROTOCOL_MIN_VERSION,
  SUPPORTED_HOST_FEATURE_VERSIONS,
  parseHostFeatureManifest,
  type HostFeatureManifest,
} from "@/lib/platform/host-feature-manifest"
import { getCommandDescriptor } from "@/lib/tauri/command-descriptors"
import type { HostRuntimeSnapshot, RuntimeSnapshot } from "./operation-availability"

const EMPTY_SNAPSHOT: RuntimeSnapshot = Object.freeze({
  target: null,
  vaultState: "unavailable",
  connectionState: "offline",
})

let currentSnapshot: RuntimeSnapshot = EMPTY_SNAPSHOT
const listeners = new Set<() => void>()

export function getRuntimeSnapshot(): RuntimeSnapshot {
  return currentSnapshot
}

export function getServerRuntimeSnapshot(): RuntimeSnapshot {
  return EMPTY_SNAPSHOT
}

export function subscribeRuntimeSnapshot(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function setRuntimeSnapshot(snapshot: RuntimeSnapshot): void {
  if (runtimeSnapshotsEqual(currentSnapshot, snapshot)) return
  currentSnapshot = freezeSnapshot(snapshot)
  for (const listener of listeners) listener()
}

export function updateRuntimeSnapshot(patch: Partial<RuntimeSnapshot>): void {
  setRuntimeSnapshot({ ...currentSnapshot, ...patch })
}

/**
 * Convert the negotiated wire manifest into the minimal facts consumed by
 * operation availability. V2 trusts only explicitly healthy operations and
 * explicit device grants. V1 has no grant field, so compatibility derives
 * grants from the capabilities of operations that the old host advertised;
 * the host remains the final authorization boundary for every RPC.
 */
export function runtimeHostSnapshotFromManifest(
  value: unknown,
  options: { hostStateWriteEnabled?: boolean } = {}
): HostRuntimeSnapshot {
  const manifest = parseHostFeatureManifest(value)
  if (!manifest) return { compatible: false, operations: [], grants: [] }
  if (
    manifest.schemaVersion === 2 &&
    (manifest.protocol.max < HOST_PROTOCOL_MIN_VERSION ||
      manifest.protocol.min > HOST_PROTOCOL_MAX_VERSION)
  ) {
    return { compatible: false, operations: [], grants: [] }
  }

  const operations =
    manifest.schemaVersion === 2
      ? manifest.operations
          .filter(
            (operation) =>
              operation.healthy &&
              SUPPORTED_HOST_FEATURE_VERSIONS[operation.feature].includes(operation.featureVersion)
          )
          .map((operation) => operation.name)
      : listV1Operations(manifest)

  const gatedOperations =
    options.hostStateWriteEnabled === false
      ? operations.filter((operation) => operation !== "host_state_submit")
      : operations

  const grants =
    manifest.schemaVersion === 2
      ? manifest.deviceGrants
      : gatedOperations.flatMap((operation) => {
          const descriptor = getCommandDescriptor(operation)
          return descriptor ? [descriptor.capability] : []
        })

  return {
    compatible: true,
    operations: [...new Set(gatedOperations)],
    grants: [...new Set(grants)],
    // Carried through rather than dropped: the ceilings are the only part of
    // the manifest a client needs to shape its UI to, and discarding them left
    // the companion shell with no way to learn them at all — the desktop's
    // remote-host store, which does keep the manifest, is empty on a phone.
    ...(manifest.limits ? { limits: manifest.limits } : {}),
  }
}

export function __resetRuntimeSnapshotForTesting(): void {
  currentSnapshot = EMPTY_SNAPSHOT
  listeners.clear()
}

function listV1Operations(manifest: HostFeatureManifest): string[] {
  return Object.values(manifest.features).flatMap((feature) => feature?.operations ?? [])
}

function freezeSnapshot(snapshot: RuntimeSnapshot): RuntimeSnapshot {
  const host = snapshot.host
    ? Object.freeze({
        ...snapshot.host,
        operations: Object.freeze([...snapshot.host.operations]),
        grants: Object.freeze([...snapshot.host.grants]),
        ...(snapshot.host.limits ? { limits: Object.freeze({ ...snapshot.host.limits }) } : {}),
      })
    : undefined
  return Object.freeze({ ...snapshot, host })
}

function runtimeSnapshotsEqual(left: RuntimeSnapshot, right: RuntimeSnapshot): boolean {
  if (
    left.target?.id !== right.target?.id ||
    left.target?.kind !== right.target?.kind ||
    left.vaultState !== right.vaultState ||
    left.connectionState !== right.connectionState ||
    left.host?.compatible !== right.host?.compatible
  ) {
    return false
  }
  return (
    arraysEqual(left.host?.operations, right.host?.operations) &&
    arraysEqual(left.host?.grants, right.host?.grants) &&
    // Cheap and exact: the limits object is a flat record of scalars plus one
    // string array, and a host that republishes different ceilings has to
    // reach every subscriber.
    JSON.stringify(left.host?.limits ?? null) === JSON.stringify(right.host?.limits ?? null)
  )
}

function arraysEqual(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined
): boolean {
  if (left === right) return true
  if (!left || !right || left.length !== right.length) return false
  return left.every((value, index) => value === right[index])
}
