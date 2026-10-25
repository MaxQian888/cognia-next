"use client"

/**
 * An org member's agent choices and month on the paired shared Host (P6g).
 *
 * The facts arrive on the member's `host_feature_manifest` (`personAgents`),
 * negotiated when the device connects. Spend moves with every turn, so the
 * composer asks again when it shows them: `refresh` re-reads the manifest and
 * patches only this field into the runtime snapshot, leaving the negotiated
 * operations and grants alone.
 */

import { useCallback } from "react"

import { useRuntimeSnapshot } from "@/hooks/use-runtime-snapshot"
import {
  parseHostFeatureManifest,
  type PersonAgentsManifest,
} from "@/lib/platform/host-feature-manifest"
import { getRuntimeSnapshot, updateRuntimeSnapshot } from "@/lib/runtime/runtime-snapshot-store"

export interface PersonAgentsDeps {
  /** The paired Host's `host_feature_manifest` answer. */
  readManifest?: () => Promise<unknown>
}

async function defaultReadManifest(): Promise<unknown> {
  const { transport } = await import("@/lib/tauri")
  return transport.call("host_feature_manifest", {})
}

/** Re-read the member's agents into the snapshot. A failed read keeps the last. */
export async function refreshPersonAgents(deps: PersonAgentsDeps = {}): Promise<void> {
  if (!getRuntimeSnapshot().host?.personPartition) return
  let manifest
  try {
    manifest = parseHostFeatureManifest(await (deps.readManifest ?? defaultReadManifest)())
  } catch {
    return
  }
  if (manifest?.schemaVersion !== 2 || manifest.personPartition !== true) return
  const personAgents = manifest.personAgents
  if (!personAgents) return
  // Re-read after the await: the device may have switched Hosts meanwhile.
  const host = getRuntimeSnapshot().host
  if (!host?.personPartition) return
  updateRuntimeSnapshot({ host: { ...host, personAgents } })
}

export function usePersonAgents(deps: PersonAgentsDeps = {}): {
  /** `null` unless the paired Host is this member's partition and declared them. */
  agents: PersonAgentsManifest | null
  refresh: () => Promise<void>
} {
  const host = useRuntimeSnapshot().host
  const { readManifest } = deps
  const refresh = useCallback(() => refreshPersonAgents({ readManifest }), [readManifest])
  return {
    agents: host?.personPartition ? (host.personAgents ?? null) : null,
    refresh,
  }
}
