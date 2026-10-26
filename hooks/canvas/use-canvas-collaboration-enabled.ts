"use client"

/**
 * Whether Canvas collaboration is offered here: the local flag AND the
 * organization's server decision.
 *
 * The client flag defaults on while the collaboration server's master switch
 * defaults off, so the flag alone offered a live session the server would then
 * refuse. The capabilities answer closes that gap. It can only narrow: when
 * the server has not answered (no plane, an older server, a failed request),
 * the flag decides alone, as before. Joining and editing an existing session
 * stays open while the feature is `existing-only`; `read-only` and `off` close
 * it. The server still decides every write itself.
 */

import { useCollabFeature } from "@/hooks/collab/use-collab-feature"
import { useCanvasFeatureFlag } from "./use-canvas-feature-flag"

export function useCanvasCollaborationEnabled(): boolean {
  const flag = useCanvasFeatureFlag("canvas.collaboration.v1")
  // Canvas sessions are org-scoped on the server; no workspace narrows them.
  const gate = useCollabFeature("canvas-collaboration", null)
  return flag && gate.canMutate
}
