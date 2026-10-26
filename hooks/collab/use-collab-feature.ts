"use client"

/**
 * One feature's server decision for one workspace, reduced to the three
 * questions an entry point asks: may I start something new, may I change what
 * exists, may I still read it.
 *
 * # When the server has not answered
 *
 * Loading, an older server without the capabilities route, no collaboration
 * plane, or a failed request: `known` is false and every answer is `true`, so
 * the caller's existing gates (the build flag, the local preference, the
 * membership) decide alone, exactly as before this hook existed. The server
 * still refuses whatever it does not admit. Local state can only ever narrow;
 * it never turns a server "no" into a "yes".
 */

import {
  admitsNew,
  allowsMutation,
  allowsRead,
  type CollabFeatureDecision,
  type CollabFeatureKey,
} from "@/lib/collab/capabilities"
import { useOrgCapabilities, type UseOrgCapabilitiesDeps } from "./use-org-capabilities"

export interface CollabFeatureGate {
  /** True once the server has decided for this scope. */
  known: boolean
  decision: CollabFeatureDecision | null
  canStart: boolean
  canMutate: boolean
  canRead: boolean
}

export function collabFeatureGate(decision: CollabFeatureDecision | null): CollabFeatureGate {
  if (!decision) {
    return { known: false, decision: null, canStart: true, canMutate: true, canRead: true }
  }
  return {
    known: true,
    decision,
    canStart: admitsNew(decision),
    canMutate: allowsMutation(decision),
    canRead: allowsRead(decision),
  }
}

export function useCollabFeature(
  key: CollabFeatureKey,
  workspaceId: string | null | undefined,
  deps?: UseOrgCapabilitiesDeps
): CollabFeatureGate {
  const view = useOrgCapabilities(workspaceId, deps)
  return collabFeatureGate(view.status === "ready" ? view.capabilities.features[key] : null)
}
