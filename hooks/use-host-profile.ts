"use client"

import { useCallback, useSyncExternalStore } from "react"

import {
  detectHostProfile,
  hasCapability,
  serverBackedCapabilities,
  type CapabilityId,
  type HostProfile,
} from "@/lib/platform/capabilities"
import { isRemoteHostActive, subscribeActiveRemoteTransport } from "@/lib/tauri/transport-routing"

/**
 * Host profile + capability availability as React hooks (ADR-0059 C3/F5).
 *
 * Mirrors `hooks/use-platform.ts`: detection lives in the framework-free
 * `lib/platform/capabilities` module; this file only adds the
 * `useSyncExternalStore` glue. The SSR / static-export snapshot is
 * `"web-standalone"` (no `window`, no localStorage pairing), the client
 * snapshot resolves the real profile on first paint. Neither the profile nor
 * the capability set changes at runtime, so `subscribe` is a no-op.
 */

const subscribe = () => () => {}

const getServerProfileSnapshot = (): HostProfile => "web-standalone"

export function useHostProfile(): HostProfile {
  return useSyncExternalStore(subscribe, detectHostProfile, getServerProfileSnapshot)
}

/**
 * Whether `cap` is available on this host — either provided by the local
 * runtime baseline or executed server-side on the host's behalf (companion
 * profiles). A desktop actively driving another Cognia host also receives the
 * same server-backed set; the hook passes that session-scoped state.
 */
export function capabilityAvailable(
  cap: CapabilityId,
  profile: HostProfile,
  remoteHostActive = false
): boolean {
  const remoteCapabilities = remoteHostActive
    ? serverBackedCapabilities("cloud-companion")
    : serverBackedCapabilities(profile)
  return hasCapability(cap) || remoteCapabilities.includes(cap)
}

/**
 * Is this shell currently driving ANOTHER Cognia host?
 *
 * Distinct from the host profile, which describes what this shell is. A
 * desktop is `desktop` whether or not it has taken over a remote host, and
 * some surfaces care about the difference: anything whose commands are
 * classified `target: "client"` still runs against the LOCAL process while the
 * rest of the app is pointed elsewhere, so it has to say so rather than
 * silently acting on the wrong machine.
 */
export function useRemoteHostActive(): boolean {
  return useSyncExternalStore(
    (notify) => subscribeActiveRemoteTransport(() => notify()),
    isRemoteHostActive,
    () => false
  )
}

/**
 * A `capabilityAvailable` closure bound to the current host profile and
 * remote-transport state — for callers that gate on a *set* of capabilities
 * (settings-section reachability) rather than one, without a hook per id.
 * Referentially stable while neither input changes, so it is safe as a memo
 * dependency.
 */
export function useCapabilityChecker(): (cap: CapabilityId) => boolean {
  const profile = useHostProfile()
  const remoteHostActive = useRemoteHostActive()
  return useCallback(
    (cap: CapabilityId) => capabilityAvailable(cap, profile, remoteHostActive),
    [profile, remoteHostActive]
  )
}

export function useCapability(cap: CapabilityId): boolean {
  return useCapabilityChecker()(cap)
}
