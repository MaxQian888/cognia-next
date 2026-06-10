/**
 * Slash command that opens the review modal.
 *
 * `/zhihu` → `ctx.modal.openModal(ReviewModal)`. Registered via the same
 * `lib/slash-commands/registry` the `prompt-templates` plugin uses, so it
 * shows up in the chat command palette. The modal is the verified-rendered UI
 * surface (sidebar panels aren't mounted by any host); the command is the
 * trigger.
 */

import { registerSlashCommand } from "@/lib/slash-commands/registry"
import type { PluginContext } from "@/types/plugin"
import { ReviewModal } from "./ui/review-modal"
import { I18N_MESSAGES } from "./i18n"
import { PLUGIN_ID } from "./ids"

// Resolve the (Chinese, per language convention) command feedback once at load.
const ZH = I18N_MESSAGES["zh-CN"] as Record<string, string>
const OPENED_MESSAGE = ZH[`plugin.${PLUGIN_ID}.command.opened`]
const NO_MODAL_MESSAGE = ZH[`plugin.${PLUGIN_ID}.command.noModal`]

/** Register the plugin's chat slash commands. Call from `activate`. */
export function registerZhihuCommands(ctx: PluginContext): void {
  registerSlashCommand({
    id: "zhihu",
    name: "/zhihu",
    description: "打开知乎选题审阅面板（候选选题 + 草稿，可一键开始写作）。",
    source: "plugin",
    pluginId: ctx.pluginId,
    handler: () => {
      if (!ctx.modal) {
        return { message: NO_MODAL_MESSAGE }
      }
      ctx.modal.openModal(ReviewModal)
      return { message: OPENED_MESSAGE }
    },
  })
}
