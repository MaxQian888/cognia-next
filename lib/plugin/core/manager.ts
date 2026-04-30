/**
 * Cognia compat shim — the plugin manager. cognia-next has a slim
 * plugin layer at `@/lib/plugin/index.ts` (skill plugins). This shim
 * exposes the same shape Cognia's canvas-plugins use: register
 * providers, fire lifecycle hooks. No-op until a real manager lands.
 */

export interface PluginManagerLike {
  register: (id: string, plugin: unknown) => () => void
  unregister: (id: string) => void
  list: () => string[]
  enablePlugin: (id: string) => Promise<void>
  disablePlugin: (id: string) => Promise<void>
  unloadPlugin: (id: string) => Promise<void>
}

let _instance: PluginManagerLike | null = null

export function getPluginManager(): PluginManagerLike {
  if (_instance) return _instance
  const registry = new Map<string, unknown>()
  _instance = {
    register: (id, plugin) => {
      registry.set(id, plugin)
      return () => {
        registry.delete(id)
      }
    },
    unregister: (id) => {
      registry.delete(id)
    },
    list: () => Array.from(registry.keys()),
    enablePlugin: async () => {},
    disablePlugin: async () => {},
    unloadPlugin: async (id) => {
      registry.delete(id)
    },
  }
  return _instance
}
