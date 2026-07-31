/**
 * Routing Presets type definitions
 * One-click routing profiles for quick configuration
 */

import type { RoutingStrategy } from "./auto-router"
import type { ModelMapping } from "./model-mapping"
import type { RoutingConfig } from "./model-mapping"

/** Built-in preset identifiers */
export type BuiltInPresetId = "budget" | "performance" | "reliability"

/** A routing preset definition */
export interface RoutingPreset {
  /** Unique identifier */
  id: string
  /** Display name */
  name: string
  /** Description of what this preset optimizes for */
  description: string
  /** Whether this is a built-in preset */
  isBuiltIn: boolean
  /** Built-in preset identifier (only for built-in presets) */
  builtInId?: BuiltInPresetId
  /** Routing strategy to activate */
  strategy: RoutingStrategy
  /** Model mappings to apply */
  mappings: Omit<ModelMapping, "id" | "createdAt" | "updatedAt">[]
  /** Routing config overrides */
  routingConfig?: Partial<RoutingConfig>
  /** Icon identifier for UI */
  icon?: string
  /** Creation timestamp (for custom presets) */
  createdAt?: number
}

/** Custom preset saved by the user */
export interface CustomPreset extends RoutingPreset {
  isBuiltIn: false
  createdAt: number
}

/** Presets store state */
export interface RoutingPresetsState {
  /** Custom presets saved by the user */
  customPresets: CustomPreset[]
  /** Currently active preset ID (null = no preset active) */
  activePresetId: string | null
  /** Snapshot of config before last preset activation (for revert) */
  preActivationSnapshot: PreActivationSnapshot | null
}

/** Snapshot for reverting preset activation */
export interface PreActivationSnapshot {
  strategy: RoutingStrategy
  mappings: ModelMapping[]
  routingConfig: RoutingConfig
  timestamp: number
}

/** Default presets state */
export const DEFAULT_ROUTING_PRESETS_STATE: RoutingPresetsState = {
  customPresets: [],
  activePresetId: null,
  preActivationSnapshot: null,
}
