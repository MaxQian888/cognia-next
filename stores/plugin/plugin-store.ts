/**
 * Minimal plugin-store stub for the agent-mode hook.
 *
 * Cognia's `usePluginStore` exposes plugin-defined agent modes. cognia-next
 * has no plugin SDK yet; the agent-mode hook still calls `getAllModes()`
 * so we return an empty list. Replace if/when a plugin runtime is added.
 */

import { create } from "zustand"
import type { AgentModeConfig } from "@/types/agent/agent-mode"

interface PluginStoreState {
  getAllModes: () => AgentModeConfig[]
}

export const usePluginStore = create<PluginStoreState>(() => ({
  getAllModes: () => [],
}))
