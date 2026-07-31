/**
 * Plugin SDK helper for the `modal-mount` capability.
 *
 * Pure typesafety pass-through for `manifest.modalMounts[]` entries.
 */

import type { PluginModalMountDef } from "@/types/plugin/plugin-modal"

export function defineModalMount(def: PluginModalMountDef): PluginModalMountDef {
  return def
}
