/**
 * The plugin contract's share of `lib/plugin/core/compatibility.ts`, which re-exports these.
 */
export type CompatibilitySeverity = "error" | "warning"

export interface CompatibilityDiagnostic {
  severity: CompatibilitySeverity
  code: string
  field: string
  message: string
  hint?: string
  expected?: string
  actual?: string
}

export interface CompatibilityRuntime {
  cogniaVersion: string
  nodeVersion?: string
  pythonVersion?: string
}

export interface CompatibilityEvaluation {
  compatible: boolean
  diagnostics: CompatibilityDiagnostic[]
}
