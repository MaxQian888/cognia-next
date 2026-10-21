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
 * Declarative pre-registration via `manifest.modalMounts[]` is resolved by
 * `modal-mount-bridge.ts`; open one by its declared id via `openById`.
 *
 * ADR-0026 §3 §A.
 */

import { createPluginSystemLogger } from "../core/logger"
import {
  clearModalsForPlugin,
  openDeclaredModal,
  usePluginModalStore,
} from "@/stores/plugin-runtime/plugin-modal-store"
import type { PluginModalAPI } from "@cognia/plugin-contract/lib/plugin/api/modal-api"
export type { PluginModalAPI } from "@cognia/plugin-contract/lib/plugin/api/modal-api"

export function createModalAPI(pluginId: string): PluginModalAPI {
  const logger = createPluginSystemLogger(pluginId)
  return {
    openModal(component, args, options) {
      const modalId = usePluginModalStore.getState().open({ pluginId, component, args, options })
      logger.info(`[modal] opened ${modalId}`)
      return {
        modalId,
        close: () => {
          usePluginModalStore.getState().close(modalId)
          logger.info(`[modal] closed ${modalId}`)
        },
      }
    },
    async openById(modalId, args, options) {
      const resolvedId = await openDeclaredModal(pluginId, modalId, args, options)
      if (!resolvedId) {
        logger.warn(`[modal] openById("${modalId}") — unknown id or component failed to load`)
        return null
      }
      logger.info(`[modal] opened declared modal ${modalId} as ${resolvedId}`)
      return {
        modalId: resolvedId,
        close: () => {
          usePluginModalStore.getState().close(resolvedId)
          logger.info(`[modal] closed ${resolvedId}`)
        },
      }
    },
    closeAll() {
      clearModalsForPlugin(pluginId)
      logger.info(`[modal] closed all modals owned by ${pluginId}`)
    },
  }
}
