import {
  V as RoutingStrategy,
  n as ModelMapping,
  I as RoutingConfig,
} from "./auto-router-CU21j5Mo.js"
import "./provider.js"
import "./built-in-provider-catalog.js"
import "./bedrock.js"
import "./circuit-breaker.js"
import "./health-metrics.js"
import "./error-class.js"

/**
 * Routing Presets type definitions
 * One-click routing profiles for quick configuration
 */

/** Built-in preset identifiers */
type BuiltInPresetId = "budget" | "performance" | "reliability"
/** A routing preset definition */
interface RoutingPreset {
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
interface CustomPreset extends RoutingPreset {
  isBuiltIn: false
  createdAt: number
}
/** Presets store state */
interface RoutingPresetsState {
  /** Custom presets saved by the user */
  customPresets: CustomPreset[]
  /** Currently active preset ID (null = no preset active) */
  activePresetId: string | null
  /** Snapshot of config before last preset activation (for revert) */
  preActivationSnapshot: PreActivationSnapshot | null
}
/** Snapshot for reverting preset activation */
interface PreActivationSnapshot {
  strategy: RoutingStrategy
  mappings: ModelMapping[]
  routingConfig: RoutingConfig
  timestamp: number
}
/** Default presets state */
declare const DEFAULT_ROUTING_PRESETS_STATE: RoutingPresetsState

export {
  type BuiltInPresetId,
  type CustomPreset,
  DEFAULT_ROUTING_PRESETS_STATE,
  type PreActivationSnapshot,
  type RoutingPreset,
  type RoutingPresetsState,
}
