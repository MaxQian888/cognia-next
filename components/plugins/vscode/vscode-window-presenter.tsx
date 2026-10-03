"use client"

/**
 * The React side of `vscode.window` (see `lib/plugin/vscode-shim/window-handlers.ts`):
 *
 *   - messages: a sonner toast, or a dialog in the plugin modal stack when modal;
 *   - quick inputs: the plugin modal stack;
 *   - notification progress and output notices: sonner toasts;
 *   - status bar entries: each extension's own `statusbar.left` / `statusbar.right`
 *     registrations, made while it has something to show;
 *   - file dialogs: the desktop's native dialogs.
 *
 * Everything goes through surfaces already mounted on every shell, so
 * nothing new needs mounting.
 */

import { createElement, type ComponentType } from "react"
import { toast } from "sonner"

import { createExtensionAPI } from "@/lib/plugin/api/extension-api"
import { requestPluginNavigation } from "@/lib/plugin/api/navigation-request"
import { buildPluginLogsHref } from "@/lib/plugin/devtools/plugin-logs-link"
import { pickOpenUris, pickSaveUri } from "@/lib/plugin/vscode-shim/native-dialogs"
import {
  cancelProgress,
  type VscodeWindowPresenter,
} from "@/lib/plugin/vscode-shim/window-handlers"
import { usePluginModalStore } from "@/stores/plugin-runtime/plugin-modal-store"
import type { ExtensionProps } from "@/types/plugin"

import {
  VscodeMessageDialog,
  VscodeMessageToast,
  VscodeOutputToast,
  VscodeProgressToast,
} from "./vscode-notices"
import { VscodeQuickInput } from "./vscode-quick-input"
import { VscodeStatusBarEntries } from "./vscode-status-bar"

/** How long a message without choices stays, as VS Code's notification toasts do. */
export const MESSAGE_TOAST_MS = 10_000
/** One "wrote to its output" notice per channel per this long. */
export const OUTPUT_NOTICE_INTERVAL_MS = 30_000

export function createVscodeWindowPresenter(
  options: { now?: () => number } = {}
): VscodeWindowPresenter & { dispose(): void } {
  const now = options.now ?? (() => Date.now())
  const statusBars = new Map<string, Array<() => void>>()
  const outputNotices = new Map<string, number>()

  const statusBarComponent = (
    pluginId: string,
    alignment: 1 | 2
  ): ComponentType<ExtensionProps> => {
    function VscodeStatusBarSlot() {
      return createElement(VscodeStatusBarEntries, { pluginId, alignment })
    }
    VscodeStatusBarSlot.displayName = `VscodeStatusBar(${pluginId}, ${alignment === 1 ? "left" : "right"})`
    return VscodeStatusBarSlot
  }

  return {
    showMessage(request) {
      return new Promise<number | null>((resolve) => {
        let settled = false
        const settle = (index: number | null) => {
          if (settled) return
          settled = true
          resolve(index)
        }
        if (request.modal) {
          usePluginModalStore.getState().open({
            pluginId: request.pluginId,
            component: VscodeMessageDialog,
            args: { request, settle },
            options: { size: "sm" },
          })
          return
        }
        toast.custom(
          (id) =>
            createElement(VscodeMessageToast, {
              request,
              onChoose: (index) => {
                settle(index)
                toast.dismiss(id)
              },
            }),
          {
            unstyled: true,
            // A message that asks something waits for the answer.
            duration: request.items.length > 0 ? Number.POSITIVE_INFINITY : MESSAGE_TOAST_MS,
            onDismiss: () => settle(null),
            onAutoClose: () => settle(null),
          }
        )
      })
    },

    openQuickInput(pluginId, sessionId) {
      const modalId = usePluginModalStore.getState().open({
        pluginId,
        component: VscodeQuickInput,
        args: { sessionId },
        options: { size: "md" },
      })
      return { close: () => usePluginModalStore.getState().close(modalId) }
    },

    showProgress(pluginId, handle) {
      toast.custom(
        () =>
          createElement(VscodeProgressToast, {
            handle,
            onCancel: () => cancelProgress(pluginId, handle),
          }),
        { id: handle, unstyled: true, duration: Number.POSITIVE_INFINITY, dismissible: false }
      )
    },

    hideProgress(handle) {
      toast.dismiss(handle)
    },

    syncStatusBar(pluginIds) {
      const wanted = new Set(pluginIds)
      for (const [pluginId, disposers] of statusBars) {
        if (wanted.has(pluginId)) continue
        for (const dispose of disposers) dispose()
        statusBars.delete(pluginId)
      }
      for (const pluginId of wanted) {
        if (statusBars.has(pluginId)) continue
        const extensions = createExtensionAPI(pluginId)
        statusBars.set(pluginId, [
          extensions.registerExtension("statusbar.left", statusBarComponent(pluginId, 1)),
          extensions.registerExtension("statusbar.right", statusBarComponent(pluginId, 2)),
        ])
      }
    },

    outputShown(pluginId, channel) {
      const key = `${pluginId}\u0000${channel}`
      const last = outputNotices.get(key)
      if (last !== undefined && now() - last < OUTPUT_NOTICE_INTERVAL_MS) return
      outputNotices.set(key, now())
      toast.custom(
        (id) =>
          createElement(VscodeOutputToast, {
            pluginId,
            channel,
            onOpenLogs: () => {
              requestPluginNavigation(pluginId, buildPluginLogsHref({ pluginId }))
              toast.dismiss(id)
            },
            onDismiss: () => toast.dismiss(id),
          }),
        { unstyled: true, duration: MESSAGE_TOAST_MS }
      )
    },

    pickOpen: (options) => pickOpenUris(options),
    pickSave: (options) => pickSaveUri(options),

    dispose() {
      for (const disposers of statusBars.values()) for (const dispose of disposers) dispose()
      statusBars.clear()
      outputNotices.clear()
    },
  }
}
