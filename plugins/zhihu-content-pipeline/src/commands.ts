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
import { I18N_MESSAGES } from "./i18n"

/**
 * Resolve a plugin i18n key for command feedback. Prefers `ctx.i18n.t` (the
 * host-merged bundle under `plugin.<id>.*`, resolved against the ACTIVE
 * locale); falls back to the raw module bundle so the command still answers in
 * contexts where the manifest i18n merge has not run (bare contexts, tests).
 * Never hardcode a locale — the earlier `I18N_MESSAGES["zh-CN"]` lookup made
 * every toast Chinese regardless of the user's language.
 */
function t(ctx: PluginContext, key: string): string {
  const viaHost = ctx.i18n?.t?.(key)
  if (viaHost && viaHost !== key) return viaHost
  const locale = ctx.i18n?.getCurrentLocale?.() ?? "en"
  const bundles = I18N_MESSAGES as Record<string, Record<string, string>>
  return bundles[locale]?.[key] ?? bundles.en[key] ?? key
}

/**
 * Handle the plugin's DECLARED `/zhihu` command (plugin.json `commands[]`).
 * Returns `null` when the command isn't ours so the host keeps dispatching to
 * other plugins; otherwise a `PluginCommandResult` owning the response.
 */
export function handleZhihuCommand(
  ctx: PluginContext,
  command: string
): PluginCommandResult | null {
  if (command !== "zhihu") return null
  if (!ctx.modal) return { handled: true, message: t(ctx, "command.noModal") }
  ctx.modal.openModal(ReviewModal)
  return { handled: true, message: t(ctx, "command.opened") }
}
