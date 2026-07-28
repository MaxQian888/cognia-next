/**
 * Modal-mount bridge — the declarative half of ADR-0026 §3 §A.
 *
 * Registers every `manifest.modalMounts[]` entry into the plugin modal store's
 * declarative registry on enable, binding each to the plugin's importer so the
 * component is resolved lazily the first time the modal is opened (via a deep
 * link, slash command, or `ctx.modal.openById`). Disable drops them all.
 *
 * Mirrors the other async module bridges: `register(manifest, installRoot,
 * { importer })` + `unregister(pluginId)`, wired into the manager via
 * `MODULE_BRIDGE_CAPABILITIES` (`manifestField: "modalMounts"`).
 */

import type { PluginManifest } from "@/types/plugin/plugin"
import type { PluginModalComponent } from "@/types/plugin/plugin-modal"
import {
  registerDeclaredModal,
  unregisterDeclaredModalsForPlugin,
} from "@/stores/plugin-runtime/plugin-modal-store"
import { resolvePluginPath } from "@/lib/plugin/core/plugin-path"

export interface RegisterModalMountsOptions {
  importer: (entry: string) => Promise<Record<string, unknown>>
}

export async function registerModalMountsForPlugin(
  manifest: PluginManifest,
  installRoot: string,
  options: RegisterModalMountsOptions
): Promise<void> {
  const defs = manifest.modalMounts ?? []
  for (const def of defs) {
    if (!def?.id || !def.entry || !def.export) continue
    const resolved = resolvePluginPath(installRoot, def.entry)
    registerDeclaredModal({
      pluginId: manifest.id,
      id: def.id,
      label: def.label ?? def.id,
      labelKey: def.labelKey,
      // Carried verbatim; the renderer's resolver is what decides whether a
      // value is meaningful, so a manifest that slipped past validation (an
      // older install, a hand-edited file) degrades to the default presentation
      // rather than blocking registration of an otherwise working modal.
      options: def.options,
      load: async () => {
        const mod = await options.importer(resolved)
        const exported = mod[def.export]
        return typeof exported === "function" ? (exported as PluginModalComponent) : null
      },
    })
  }
}

export function unregisterModalMountsForPlugin(pluginId: string): void {
  unregisterDeclaredModalsForPlugin(pluginId)
}
