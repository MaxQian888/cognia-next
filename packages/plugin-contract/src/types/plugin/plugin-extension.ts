import type { CanonicalExtensionPoint } from "@/lib/plugin/contracts/plugin-points"

/**
 * Declarative React contribution mounted at one of Cognia's canonical UI
 * extension points. The host resolves the named export before plugin
 * activation and registers it through the same registry as
 * `ctx.extensions.registerExtension()`.
 */
export interface PluginExtensionDef {
  point: CanonicalExtensionPoint
  entry: string
  export: string
  priority?: number
  when?: string
  minWidth?: number
  maxWidth?: number
  /** Plugin i18n key used by contribution discovery UI. */
  labelKey?: string
}
