/**
 * The plugin contract's share of `lib/tray/registry.ts`, which re-exports these.
 */

export interface PluginTrayItem {
  id: string
  pluginId: string
  label: string
  labelKey?: string
  icon?: string
  /** when-expression evaluated by `lib/tray/when.ts` before flushing. */
  when?: string
  /** Free-form category — used by `lib/tray/all-commands.ts` for grouping. */
  category?: string
  /** Optional shortcut hint, cosmetic in the OS menu. */
  accelerator?: string
  command?: string
  slash?: string
  run?: () => void | Promise<void>
}
