/**
 * Plugin SDK — `modal-mount` capability surface.
 *
 * Re-exports the authoring helper, manifest bridge, plugin context API, and
 * declared modal registry used by plugin-contributed modal mounts.
 */

export { defineModalMount } from "../define/define-modal-mount"

export {
  registerModalMountsForPlugin,
  unregisterModalMountsForPlugin,
} from "@/lib/plugin/bridge/modal-mount-bridge"

export type { RegisterModalMountsOptions } from "@/lib/plugin/bridge/modal-mount-bridge"

export { createModalAPI } from "@/lib/plugin/api/modal-api"
export type { PluginModalAPI } from "@/lib/plugin/api/modal-api"

export {
  clearModalsForPlugin,
  getDeclaredModal,
  listDeclaredModals,
  openDeclaredModal,
  registerDeclaredModal,
  selectAllModals,
  selectTopModal,
  subscribeDeclaredModals,
  unregisterDeclaredModalsForPlugin,
} from "@/stores/plugin-runtime/plugin-modal-store"

export type { DeclaredModalEntry } from "@/stores/plugin-runtime/plugin-modal-store"

export type {
  PluginModalComponent,
  PluginModalEntry,
  PluginModalHandle,
  PluginModalMountDef,
  PluginModalProps,
} from "@/types/plugin/plugin-modal"
