/**
 * Plugin SDK — `tray-item` capability surface.
 *
 * Exports the authoring helper, the types of `ctx.tray`, and the renderer
 * tray registry used by plugin-contributed tray menu items. The host builds
 * `ctx.tray`.
 */

export { defineTrayItem } from "../define/define-tray-item"

export {
  getTrayItem,
  listTrayItems,
  listTrayItemsByPlugin,
  registerTrayItem,
  subscribeTrayItems,
  unregisterTrayItem,
  unregisterTrayItemsByPlugin,
} from "@/lib/tray/registry"

export type { PluginTrayItem } from "@/lib/tray/registry"
export type {
  PluginTrayAPI,
  PluginTrayItemInput,
} from "@cognia/plugin-contract/types/plugin/plugin"
