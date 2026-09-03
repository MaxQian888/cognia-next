"use client"

/**
 * The process-plane verdict, as something a component re-renders on.
 *
 * `externalAgentProcessPlane()` is a synchronous look at three module getters:
 * the remote-host store, the runtime snapshot, and the transport routing flag.
 * Reading it straight from render makes the answer correct exactly once, at
 * the moment that render happened, and nothing brings the component back when
 * it changes.
 *
 * That is not a theoretical staleness. `manifest-missing` is the verdict for a
 * paired Host that is still reporting what it supports, and it resolves on its
 * own moments later. A panel that reads it once disables its Connect button,
 * shows copy promising the state will clear, and then has no reactive input
 * left that could bring it back: connection status cannot move while the
 * control that would move it is disabled. Subscribing is what makes the
 * promise in that copy true.
 *
 * The subscription is the union of the two stores the plane consults.
 * `isRemoteHostActive()` is a module flag rather than a store, but it is
 * written by the remote-host store as it activates and clears a host, so that
 * store's subscription covers it too.
 */

import { useMemo, useSyncExternalStore } from "react"

import {
  externalAgentProcessPlane,
  externalAgentProcessPlaneScope,
  subscribeExternalAgentProcessPlane as subscribe,
  type ProcessPlaneAvailability,
  type ProcessPlaneCommand,
} from "@/lib/ai/agent/external/process-plane"

/**
 * A value `useSyncExternalStore` can compare.
 *
 * The verdict is a fresh object on every call, so returning it directly would
 * make the store look changed on every check and re-render forever. The
 * flattened string is the same value whenever the answer is the same, and the
 * object is rebuilt only when it moves.
 */
function verdictKey(operation?: ProcessPlaneCommand): string {
  const verdict = externalAgentProcessPlane(operation)
  const scope = externalAgentProcessPlaneScope()
  return `${scope}:${verdict.ok ? `ok:${verdict.via}` : `no:${verdict.reason}`}`
}

/** No host of any kind is reachable from a server render. */
const SERVER_KEY = "no:no-host"

export function useExternalAgentProcessPlane(
  operation?: ProcessPlaneCommand
): ProcessPlaneAvailability {
  const key = useSyncExternalStore(
    subscribe,
    () => verdictKey(operation),
    () => SERVER_KEY
  )
  // `key` is in the deps because it is the only thing that says the answer
  // moved. Recomputing the verdict rather than parsing the key back keeps this
  // module from owning a second copy of the plane's vocabulary, and the lint
  // rule cannot see that the call it is memoizing reads the same stores the
  // key was computed from.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is the change signal for a value read outside React
  return useMemo(() => externalAgentProcessPlane(operation), [key, operation])
}
