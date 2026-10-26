/**
 * Plugin SDK — `quick-action` capability surface.
 *
 * Re-exports the authoring helper and quick-action registry used for command
 * palette, composer, and tray plugin actions.
 */

export { defineQuickAction } from "../define/define-quick-action"

export {
  registerQuickAction,
  unregisterQuickActionsByPlugin,
  getQuickAction,
  listQuickActions,
  getQuickActionSnapshot,
  subscribeQuickActions,
  runQuickAction,
} from "@cognia/plugin-contract/lib/plugin/registries/quick-action-registry"

export type { QuickActionEntry } from "@cognia/plugin-contract/lib/plugin/registries/quick-action-registry"
export type {
  PluginQuickActionDef,
  PluginQuickActionInput,
  PluginQuickActionSurface,
  PluginQuickActionInvocation,
  PluginQuickActionResult,
  PluginSelectionActionSpec,
  PluginSelectionContentType,
  PluginSelectionOrigin,
  PluginSelectionQuickActionContext,
  PluginSelectionReplaceCapability,
} from "@cognia/plugin-contract/types/plugin/index"
