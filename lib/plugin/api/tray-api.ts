// Plugin-facing tray API. Mirrors `createContextMenuAPI` at
// `lib/plugin/core/context.ts:1266-1318` exactly — the contract is:
//
//   1. Namespace the user-supplied id as `<pluginId>:<localId>` so two
//      plugins can register the same local id without colliding.
//   2. Push the registration through `plugin_tray_item_register` (Rust
//      side) AND `registerTrayItem` (renderer-side registry, so the tray
//      builder can pick the item up).
//   3. Listen for `plugin-tray-item:<full id>` window events emitted when
//      the user clicks; invoke the supplied `onClick` callback.
//   4. Return a disposer that reverses all three steps.
//
// Permission gating: when the plugin doesn't declare the `"tray"`
// capability in its manifest, every call returns a no-op disposer.

"use client"

import { invoke } from "@tauri-apps/api/core"
import { loggers } from "@/lib/logger"
import type { PluginCapability, PluginTrayAPI, PluginTrayItemInput } from "@/types/plugin/plugin"
import { registerTrayItem, unregisterTrayItem } from "@/lib/tray/registry"

interface CreateTrayAPIArgs {
  pluginId: string
  capabilities: readonly PluginCapability[]
}

export function createTrayAPI({ pluginId, capabilities }: CreateTrayAPIArgs): PluginTrayAPI {
  if (!capabilities.includes("tray")) return noopTrayAPI(pluginId)

  const handlers = new Map<string, () => void>()

  function registerOne(item: PluginTrayItemInput): () => void {
    const fullId = `${pluginId}:${item.id}`
    handlers.set(fullId, item.onClick)

    invoke("plugin_tray_item_register", {
      pluginId,
      item: {
        id: fullId,
        label: item.label,
        icon: item.icon,
        when: item.when,
        category: item.category,
        accelerator: item.accelerator,
      },
    }).catch((error) => {
      loggers.tray.warn("plugin_tray_item_register failed", {
        pluginId,
        itemId: fullId,
        error: String(error),
      })
    })

    // Mirror into the renderer-side registry so `all-commands.ts` picks it
    // up without a round-trip to Rust.
    registerTrayItem({
      id: fullId,
      pluginId,
      label: item.label,
      icon: item.icon,
      when: item.when,
      category: item.category,
      accelerator: item.accelerator,
    })

    const listener = () => {
      try {
        item.onClick()
      } catch (err) {
        loggers.tray.warn("plugin tray onClick threw", {
          pluginId,
          itemId: fullId,
          error: String(err),
        })
      }
    }
    window.addEventListener(`plugin-tray-item:${fullId}`, listener)

    return () => {
      handlers.delete(fullId)
      window.removeEventListener(`plugin-tray-item:${fullId}`, listener)
      unregisterTrayItem(fullId)
      invoke("plugin_tray_item_unregister", { pluginId, itemId: fullId }).catch((error) => {
        loggers.tray.warn("plugin_tray_item_unregister failed", {
          pluginId,
          itemId: fullId,
          error: String(error),
        })
      })
    }
  }

  return {
    register: registerOne,
    registerMany: (items: PluginTrayItemInput[]) => {
      const disposers = items.map(registerOne)
      return () => disposers.forEach((d) => d())
    },
  }
}

function noopTrayAPI(pluginId: string): PluginTrayAPI {
  const warnOnce = createWarnOnce(pluginId)
  return {
    register: () => {
      warnOnce()
      return () => {}
    },
    registerMany: () => {
      warnOnce()
      return () => {}
    },
  }
}

function createWarnOnce(pluginId: string): () => void {
  let warned = false
  return () => {
    if (warned) return
    warned = true
    loggers.tray.warn(
      "plugin tried to register tray item without the 'tray' capability — declare it in plugin.json",
      { pluginId }
    )
  }
}
