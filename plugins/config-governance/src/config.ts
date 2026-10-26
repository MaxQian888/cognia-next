/**
 * The plugin's settings, read from its declarative configuration
 * (`ctx.configuration`, seeded with the manifest's schema defaults).
 */

export interface GovernanceConfig {
  /** Audit shipped prompts the user never changed. */
  auditShipped: boolean
  /** The model that judges; empty uses the app's default model. */
  auditModel: string
  /** The model the configuration is judged for; empty uses the app's default model. */
  targetModel: string
  /** Past sessions the adherence backtest replays. */
  backtestSessionLimit: number
  /** Run adopted enforcement rules in tool hooks. */
  enforcementEnabled: boolean
}

export const DEFAULT_GOVERNANCE_CONFIG: GovernanceConfig = {
  auditShipped: false,
  auditModel: "",
  targetModel: "",
  backtestSessionLimit: 50,
  enforcementEnabled: true,
}

export interface ConfigSource {
  getOrDefault<T>(key: string, fallback: T): T
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const number = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

export function readGovernanceConfig(source: ConfigSource): GovernanceConfig {
  const string = (key: keyof GovernanceConfig) => {
    const value = source.getOrDefault<unknown>(key, DEFAULT_GOVERNANCE_CONFIG[key])
    return typeof value === "string" ? value.trim() : ""
  }
  return {
    auditShipped: source.getOrDefault<unknown>("auditShipped", false) === true,
    auditModel: string("auditModel"),
    targetModel: string("targetModel"),
    backtestSessionLimit: clampInteger(
      source.getOrDefault<unknown>(
        "backtestSessionLimit",
        DEFAULT_GOVERNANCE_CONFIG.backtestSessionLimit
      ),
      5,
      500,
      DEFAULT_GOVERNANCE_CONFIG.backtestSessionLimit
    ),
    enforcementEnabled: source.getOrDefault<unknown>("enforcementEnabled", true) !== false,
  }
}
