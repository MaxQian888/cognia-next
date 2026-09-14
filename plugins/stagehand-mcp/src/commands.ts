/**
 * Slash command that opens the Stagehand setup guide.
 *
 * `/stagehand` → `ctx.modal.openModal(StagehandSetupModal)`. The command is
 * DECLARED in plugin.json (`commands[]`) and dispatched through
 * `hooks.onCommand`, so the manager owns registration (namespaced id,
 * conflict detection, palette entry) and teardown. The modal is the
 * verified-rendered UI surface; the command is the trigger.
 *
 * The hook returns a `PluginCommandResult` rather than `true` + a separate
 * toast: a bare `true` makes the host insert its generic "Command handled by
 * plugin" line into the chat on top of whatever the plugin surfaces itself.
 * Returning `{ handled, message }` puts one localized acknowledgement in the
 * session the command was typed in — and nothing else.
 */

import type { PluginCommandResult, PluginContext } from "@cognia/plugin-sdk"
import { StagehandSetupModal } from "./ui/setup-modal"
import { I18N_MESSAGES } from "./i18n"

/**
 * Preset ids the `/stagehand <arg>` shorthand can focus, and the words that
 * select each one. `stagehand` is the self-hosted stdio preset;
 * `stagehand-hosted` is Browserbase's managed Streamable-HTTP endpoint.
 */
const FOCUS_ALIASES: Record<string, string> = {
  hosted: "stagehand-hosted",
  cloud: "stagehand-hosted",
  remote: "stagehand-hosted",
  local: "stagehand",
  self: "stagehand",
  "self-hosted": "stagehand",
  selfhosted: "stagehand",
  npx: "stagehand",
  stdio: "stagehand",
  stagehand: "stagehand",
}

/**
 * Resolve a plugin i18n key for command feedback. Prefers `ctx.i18n.t` (the
 * host-merged bundle under `plugin.<id>.*`, resolved against the ACTIVE
 * locale); falls back to the raw module bundle so the command still answers
 * in contexts where the manifest i18n merge has not run (bare contexts,
 * tests). Never hardcode a locale.
 */
function t(ctx: PluginContext, key: string): string {
  const viaHost = ctx.i18n?.t?.(key)
  if (viaHost && viaHost !== key) return viaHost
  const locale = ctx.i18n?.getCurrentLocale?.() ?? "en"
  const bundles = I18N_MESSAGES as Record<string, Record<string, string>>
  return bundles[locale]?.[key] ?? bundles.en[key] ?? key
}

/**
 * Handle the plugin's DECLARED `/stagehand` command (plugin.json
 * `commands[]`). `/stagehand` alone opens the guide; `/stagehand hosted` /
 * `cloud` / `local` / `stdio` additionally highlights that preset card.
 * Returns `null` when the command isn't ours so the host keeps dispatching.
 */
export function handleStagehandCommand(
  ctx: PluginContext,
  command: string,
  args?: string[]
): PluginCommandResult | null {
  if (command !== "stagehand") return null
  if (!ctx.modal?.openModal) return { handled: true, message: t(ctx, "command.noModal") }
  const focus = args?.[0] ? FOCUS_ALIASES[args[0].toLowerCase()] : undefined
  ctx.modal.openModal(StagehandSetupModal, focus ? { focus } : undefined, { size: "lg" })
  return { handled: true, message: t(ctx, "command.opened") }
}
