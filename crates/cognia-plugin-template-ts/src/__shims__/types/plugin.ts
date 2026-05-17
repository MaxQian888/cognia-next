/**
 * Type shim for `@/types/plugin` so the template's tests can run without
 * pulling the entire cognia monorepo. The real definitions live in
 * `types/plugin/plugin.ts` and are resolved by the host at runtime via the
 * `@/*` path alias in the cognia app's tsconfig.
 *
 * Authors editing the template don't need to expand these — write your
 * plugin code against the real types in your own tsconfig.
 */

export interface PluginLogger {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
  debug?: (...args: unknown[]) => void
}

export interface PluginContext {
  pluginId: string
  logger?: PluginLogger
  agent?: {
    registerTool?: (tool: {
      name: string
      pluginId: string
      definition: unknown
      execute: (args: Record<string, unknown>) => Promise<unknown>
    }) => void
  }
  storage?: {
    get: <T>(key: string) => Promise<T | undefined>
    set: (key: string, value: unknown) => Promise<void>
    remove: (key: string) => Promise<void>
  }
}

export interface PluginDefinition {
  manifest: unknown
  activate?: (ctx: PluginContext) => Promise<void> | void
  deactivate?: (ctx?: PluginContext) => Promise<void> | void
}
