/**
 * Slash command that opens the review modal.
 *
 * `/zhihu` → `ctx.modal.openModal(ReviewModal)`. The command is DECLARED in
 * plugin.json (`commands[]`) and dispatched through `hooks.onCommand`, so the
 * manager owns registration (namespaced id, conflict detection, palette entry)
 * and teardown. The modal is the verified-rendered UI surface (sidebar panels
 * aren't mounted by any host); the command is the trigger.
 *
 * The hook returns a `PluginCommandResult` rather than `true` + a separate
 * toast: a bare `true` makes the host insert its generic "Command handled by
 * plugin" line into the chat on top of whatever the plugin surfaces itself.
 * Returning `{ handled, message }` puts one localized acknowledgement in the
 * session the command was typed in — and nothing else.
 */

import type { PluginCommandResult, PluginContext } from "@cognia/plugin-sdk"
import { ReviewModal } from "./ui/review-modal"

/**
 * Handle the plugin's DECLARED `/zhihu` command (plugin.json `commands[]`).
 * Returns `null` when the command isn't ours so the host keeps dispatching to
 * other plugins; otherwise a `PluginCommandResult` owning the response.
 */
export function handleZhihuCommand(
  ctx: Pick<PluginContext, "modal" | "i18n">,
  command: string
): PluginCommandResult | null {
  if (command !== "zhihu") return null
  // `lg`: the host sizes the dialog; the modal body itself sets no width, so
  // it can never overflow a 375px screen.
  ctx.modal.openModal(ReviewModal, undefined, { size: "lg" })
  return { handled: true, message: ctx.i18n.t("command.opened") }
}
