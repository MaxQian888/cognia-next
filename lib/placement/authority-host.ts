"use client"

/**
 * Liveness of the configured execution authority.
 *
 * Kept in its own module so `authority.ts` stays a pure decision function that
 * a test can drive with a literal, and so the only thing importing the
 * remote-host store is the seam that genuinely needs it.
 *
 * `capabilitiesAt` / `featureManifestAt` are written in six places and, until
 * now, read in none. They are exactly the evidence this needs: the last time
 * this machine successfully exchanged a manifest with that host.
 */

import { useRemoteHostStore } from "@/stores/remote-host/remote-host-store"

import type { PlacementLiveness } from "./liveness"

/**
 * `null` when the host is not registered here at all — which is a different
 * answer from "registered and stale", and the caller treats it differently.
 */
export function authorityHostLiveness(hostId: string): PlacementLiveness | null {
  const host = useRemoteHostStore.getState().hosts.find((candidate) => candidate.id === hostId)
  if (!host) return null

  const lastSeenAt = Math.max(
    host.lastConnectedAt ?? 0,
    host.featureManifestAt ?? 0,
    host.capabilitiesAt ?? 0
  )
  return {
    // `revoked` and `versionMismatch` are not transient: the host is not coming
    // back on its own, so it must not hold timing authority while we wait.
    online: host.connectionState !== "revoked" && host.connectionState !== "versionMismatch",
    lastSeenAt,
    source: "manifest",
  }
}
