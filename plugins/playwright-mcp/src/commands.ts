/**
 * Slash command that opens the Playwright setup guide.
 *
 * `/browser` → `ctx.modal.openModal(PlaywrightSetupModal)`. The command is
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
import { PlaywrightSetupModal } from "./ui/setup-modal"
import { I18N_MESSAGES } from "./i18n"

/**
 * Preset ids the `/browser <arg>` shorthand can focus, and the words that
 * select each one. `playwright` / `playwright-existing-browser` are static
 * catalog presets this plugin only *points at*; `playwright-isolated` and
 * `playwright-cdp` are contributed by this plugin itself.
 */
const FOCUS_ALIASES: Record<string, string> = {
  playwright: "playwright",
  default: "playwright",
  isolated: "playwright-isolated",
  extension: "playwright-existing-browser",
  existing: "playwright-existing-browser",
  cdp: "playwright-cdp",
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
 * Handle the plugin's DECLARED `/browser` command (plugin.json
 * `commands[]`). `/browser` alone opens the guide; `/browser isolated` /
 * `extension` / `cdp` additionally highlights that preset card. Returns
 * `null` when the command isn't ours so the host keeps dispatching.
 */
export function handleBrowserCommand(
  ctx: PluginContext,
  command: string,
  args?: string[]
): PluginCommandResult | null {
  if (command !== "browser") return null
  if (!ctx.modal?.openModal) return { handled: true, message: t(ctx, "command.noModal") }
  const focus = args?.[0] ? FOCUS_ALIASES[args[0].toLowerCase()] : undefined
  ctx.modal.openModal(PlaywrightSetupModal, focus ? { focus } : undefined, { size: "lg" })
  return { handled: true, message: t(ctx, "command.opened") }
}
