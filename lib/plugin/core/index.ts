/**
 * Core Plugin System - Main exports
 */

export { PluginManager, getPluginManager, initializePluginManager } from "./manager"
export type { PythonRuntimeInfo } from "./manager"
export { PluginLoader } from "./loader"
export { PluginRegistry } from "./registry"
export {
  createPluginContext,
  createFullPluginContext,
  isFullPluginContext,
  type FullPluginContext,
} from "./context"
export { PluginSandbox } from "./sandbox"
export { validatePluginManifest, validatePluginConfig, parseManifest } from "./validation"
export type { ValidationError, ValidationResult, ConfigValidationResult } from "./validation"
export { evaluatePluginCompatibility } from "./compatibility"
export type {
  CompatibilityRuntime,
  CompatibilityDiagnostic,
  CompatibilityEvaluation,
} from "./compatibility"
export { buildExtensionDescriptor, derivePluginInstallRootKind } from "./descriptor"
export { createPluginSystemLogger, pluginLogger, loggers, type PluginSystemLogger } from "./logger"
export { createPluginVerificationSnapshot } from "./verification"
