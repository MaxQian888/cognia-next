import type { PluginContext, PluginPermission } from "./plugin"

/** JSON Schema draft-07, including boolean schemas. */
export type PluginLibrarySchema = boolean | { [keyword: string]: unknown }

export type PluginLibraryRisk = "read" | "write" | "destructive"

export interface PluginLibraryMethod {
  description: string
  /** Schema for the complete positional argument array. */
  inputSchema: PluginLibrarySchema
  /** Results must be JSON data; operations without a result return null. */
  outputSchema: PluginLibrarySchema
  risk: PluginLibraryRisk
  requiredPermissions: PluginPermission[]
  /** Public module-level Python function. JS providers register through IPC. */
  handler?: string
}

export interface PluginLibraryModule {
  /** Dedicated, bundled CJS factory entry relative to the provider root. */
  entry: string
  description: string
  risk: PluginLibraryRisk
  requiredPermissions: PluginPermission[]
}

export interface PluginLibraryContract {
  rpc?: Record<string, PluginLibraryMethod>
  modules?: Record<string, PluginLibraryModule>
}

export interface PluginLibrariesAPI {
  /** Return one independent module instance per consumer activation. */
  importModule<T extends Record<string, unknown> = Record<string, unknown>>(
    providerId: string,
    moduleName: string
  ): Promise<T>
}

export interface PluginLibraryModuleInstance<
  T extends Record<string, unknown> = Record<string, unknown>,
> {
  exports: T
  dispose?: () => void | Promise<void>
}

/** Receives the consumer's guarded, lifetime-fenced context, never the provider's. */
export type PluginLibraryModuleFactory<
  T extends Record<string, unknown> = Record<string, unknown>,
> = (ctx: PluginContext) => PluginLibraryModuleInstance<T> | Promise<PluginLibraryModuleInstance<T>>
