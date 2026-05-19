/**
 * Plugin Modal API.
 *
 * Lets a plugin open a modal from anywhere in its code via
 * `ctx.modal.openModal(component, props)`. The host's `<PluginModalRoot />`
 * (mounted once in `app/layout.tsx`) renders the top-of-stack entry.
 *
 * Returns a `PluginModalHandle` whose `close()` pops the entry. The plugin
 * manager also clears every modal the plugin owns when the plugin is
 * disabled (via `clearModalsForPlugin`).
 *
 * Declarative pre-registration via `manifest.modalMounts[]` lands in a
 * follow-up — the imperative path here covers the common case.
 *
 * ADR-0026 §3 §A.
 */

import { createPluginSystemLogger } from "../core/logger"
import { clearModalsForPlugin, usePluginModalStore } from "@/stores/plugin/plugin-modal-store"
import type { PluginModalComponent, PluginModalHandle } from "@/types/plugin/plugin-modal"

export interface PluginModalAPI {
  /**
   * Push a new modal onto the stack. Returns a handle whose `close()`
   * dismisses it. Plugin authors should usually close from inside the
   * modal component (via the `onClose` prop) rather than holding the
   * handle externally.
   */
  openModal(component: PluginModalComponent, args?: Record<string, unknown>): PluginModalHandle
  /** Close every modal this plugin opened. */
  closeAll(): void
}

export function createModalAPI(pluginId: string): PluginModalAPI {
  const logger = createPluginSystemLogger(pluginId)
  return {
    openModal(component, args) {
      const modalId = usePluginModalStore.getState().open({ pluginId, component, args })
      logger.info(`[modal] opened ${modalId}`)
      return {
        modalId,
        close: () => {
          usePluginModalStore.getState().close(modalId)
          logger.info(`[modal] closed ${modalId}`)
        },
      }
    },
    closeAll() {
      clearModalsForPlugin(pluginId)
      logger.info(`[modal] closed all modals owned by ${pluginId}`)
    },
  }
}
