import type { PluginInstallRootKind, PluginSource, PluginStatus } from "./plugin"

export type PluginVerificationStage =
  | "manifest_validation"
  | "compatibility"
  | "installation"
  | "activation"
  | "runtime_execution"
  | "reload"
  | "cleanup"

export type PluginVerificationAction =
  | "validate"
  | "install"
  | "load"
  | "enable"
  | "disable"
  | "unload"
  | "reload"
  | "update"
  | "suspend"
  | "resume"
  | "uninstall"

export interface PluginVerificationDiagnostic {
  code: string
  severity: "info" | "warning" | "error"
  message: string
  hint?: string
  field?: string
  stage?: PluginVerificationStage
  source?: string
}

export interface PluginVerificationSnapshot {
  pluginId: string
  source: PluginSource
  installRootKind?: PluginInstallRootKind
  status: PluginStatus
  verificationStage: PluginVerificationStage
  lastVerifiedAction: PluginVerificationAction
  lastVerifiedAt: string
  lastSuccessfulAt?: string
  lastFailureAt?: string
  resolvedVersion?: string
  diagnostics: PluginVerificationDiagnostic[]
  metadata?: Record<string, unknown>
}

export interface CreatePluginVerificationSnapshotInput {
  pluginId: string
  source: PluginSource
  installRootKind?: PluginInstallRootKind
  declaredCapabilities?: readonly string[]
  status: PluginStatus
  verificationStage: PluginVerificationStage
  lastVerifiedAction: PluginVerificationAction
  verifiedAt: string
  successful: boolean
  lastSuccessfulAt?: string
  lastFailureAt?: string
  resolvedVersion?: string
  diagnostics?: PluginVerificationDiagnostic[]
  metadata?: Record<string, unknown>
}
