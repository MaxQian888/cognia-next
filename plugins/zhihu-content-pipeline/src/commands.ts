/**
 * Slash command that opens the review modal.
 *
 * `/zhihu` → `ctx.modal.openModal(ReviewModal)`. The command is DECLARED in
 * plugin.json (`commands[]`) and dispatched through `hooks.onCommand`, so the
 * manager owns registration (namespaced id, conflict detection, palette entry)
 * and teardown. The modal is the verified-rendered UI surface (sidebar panels
 * aren't mounted by any host); the command is the trigger.
 */

import type { PluginContext } from "@/types/plugin"
import { ReviewModal } from "./ui/review-modal"
import { I18N_MESSAGES } from "./i18n"
import { PLUGIN_ID } from "./ids"

// Resolve the (Chinese, per language convention) command feedback once at load.
const ZH = I18N_MESSAGES["zh-CN"] as Record<string, string>
const OPENED_MESSAGE = ZH[`plugin.${PLUGIN_ID}.command.opened`]
const NO_MODAL_MESSAGE = ZH[`plugin.${PLUGIN_ID}.command.noModal`]

/**
 * Handle the plugin's DECLARED `/zhihu` command (plugin.json `commands[]`).
 * Returns the message to surface, or `null` when the command isn't ours so the
 * host can keep dispatching to other plugins.
 */
export function handleZhihuCommand(ctx: PluginContext, command: string): string | null {
  if (command !== "zhihu") return null
  if (!ctx.modal) return NO_MODAL_MESSAGE
  ctx.modal.openModal(ReviewModal)
  return OPENED_MESSAGE
}
