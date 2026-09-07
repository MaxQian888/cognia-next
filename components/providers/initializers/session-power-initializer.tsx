"use client"

import { useSessionPowerGuard } from "@/hooks/power/use-session-power-guard"

/**
 * Mounts the per-conversation screen-power coordinator once, at the app root.
 *
 * Rendering nothing is the point: the hold has to outlive every chat pane, so
 * it cannot live in one. Part of the core-chat boot chunk because it is only
 * ever meaningful once conversations can run.
 */
export function SessionPowerInitializer() {
  useSessionPowerGuard()
  return null
}

export default SessionPowerInitializer
