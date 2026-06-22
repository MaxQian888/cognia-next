/**
 * Plugin SDK — `tray-item` capability surface.
 *
 * Re-exports the authoring helper, plugin context API factory, and renderer
 * tray registry used by plugin-contributed tray menu items.
 */

export { defineTrayItem } from "../define/define-tray-item"

export { createTrayAPI } from "@/lib/plugin/api/tray-api"

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
export type { PluginTrayAPI, PluginTrayItemInput } from "@/types/plugin/plugin"
