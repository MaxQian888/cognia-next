"use client"

import { useDeveloperMode } from "@/lib/plugin/devtools/developer-mode"

/**
 * Compatibility hook for plugin navigation. Developer Mode has one persisted
 * source of truth; build mode and ad-hoc localStorage flags are migrated at
 * boot and must not create a second gate.
 */
export function useDevtoolsGate(): boolean {
  return useDeveloperMode()
}
