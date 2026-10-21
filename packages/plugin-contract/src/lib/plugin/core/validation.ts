/**
 * The plugin contract's share of `lib/plugin/core/validation.ts`, which re-exports these.
 */
import type { PluginPointGovernanceMode } from "../contracts/plugin-points"

export interface ValidationError {
  field: string
  code: string
  message: string
}

export interface ManifestDiagnostic extends ValidationError {
  severity: "error" | "warning"
  hint?: string
}

export interface ValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
  diagnostics?: ManifestDiagnostic[]
}

export interface ConfigValidationResult {
  valid: boolean
  errors: ValidationError[]
  warnings: string[]
}

export interface ManifestValidationOptions {
  governanceMode?: PluginPointGovernanceMode
}
