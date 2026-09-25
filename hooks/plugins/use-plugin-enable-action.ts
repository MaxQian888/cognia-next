"use client"

/**
 * Enable / disable a plugin from any `/plugins` surface, and tell the user
 * what happened.
 *
 * Every toggle used to be `void setPluginEnabledForHost(...)`: the result was
 * dropped on the floor. A successful enable gave no hint of what the plugin now
 * contributed, a mirrored phone's queued toggle looked identical to an applied
 * one, and a failure was either silent or a raw English message with no way to
 * get to the plugin that failed. This hook keeps the ONE enable path
 * (`setPluginEnabledForHost`) and adds the feedback around it:
 *
 * - enabled   → success toast with "View contributions" (opens the detail pane
 *               on its Capabilities section through the `/plugins?plugin=` link)
 * - queued    → neutral toast saying the desktop will apply it
 * - failed    → error toast, localized reason, "View details"
 *
 * The failure toast reuses the id `PluginEnableFailureToaster` gives the
 * manager's `plugin:enable-failed` event (`<pluginId>::<message>`), so the two
 * reports of one failure collapse into a single toast instead of stacking.
 */

import { useCallback } from "react"
import { useRouter } from "next/navigation"
import { useLocale, useTranslations } from "next-intl"
import { toast } from "sonner"

import type { PluginRow } from "@/lib/db/plugin-types"
import {
  setPluginEnabledForHost,
  type SetPluginEnabledResult,
} from "@/lib/plugin/core/set-plugin-enabled-for-host"

import { usePluginErrorMessage } from "./use-plugin-error-message"
import {
  evaluatePluginEnableGate,
  useEffectivePluginRuntimeProfile,
} from "./use-plugin-enable-gate"
import { pluginDetailHref, pluginEnableFailureToastId } from "./plugin-links"
import { localizePluginText } from "./use-localized-plugin-text"

export type PluginEnableTarget = Pick<PluginRow, "id" | "name"> & {
  manifest?: PluginRow["manifest"]
}

export function usePluginEnableAction(): (
  plugin: PluginEnableTarget,
  next: boolean,
  reason?: string
) => Promise<SetPluginEnabledResult | null> {
  const t = useTranslations("plugins.lifecycleFeedback")
  const describe = usePluginErrorMessage()
  const router = useRouter()
  const profile = useEffectivePluginRuntimeProfile()
  const locale = useLocale()

  return useCallback(
    async (plugin, next, reason = "manual") => {
      // Toasts name the plugin the way the list shows it.
      const name = localizePluginText(plugin, locale).name
      // The Switch and menu item are already disabled for a blocked plugin;
      // this catches a caller that forgot to consult the gate.
      if (next && evaluatePluginEnableGate(plugin.manifest, profile).blocked) {
        toast.error(t("enableFailed", { name }), {
          description: t("enableBlocked"),
        })
        return null
      }

      const result = await setPluginEnabledForHost(plugin.id, next, reason)
      const viewDetails = {
        label: t("viewDetails"),
        onClick: () => router.push(pluginDetailHref(plugin.id)),
      }

      if (!result.ok) {
        const message = result.error ?? ""
        toast.error(t(next ? "enableFailed" : "disableFailed", { name }), {
          id: pluginEnableFailureToastId(plugin.id, message),
          description: message ? describe(message) : undefined,
          action: viewDetails,
        })
        return result
      }

      if (result.queued) {
        toast.message(t(next ? "enableQueued" : "disableQueued", { name }), {
          description: t("queuedHint"),
        })
        return result
      }

      if (next) {
        toast.success(t("enabled", { name }), {
          action: {
            label: t("viewContributions"),
            onClick: () => router.push(pluginDetailHref(plugin.id, "capabilities")),
          },
        })
      } else {
        toast.success(t("disabled", { name }))
      }
      return result
    },
    [t, describe, router, profile, locale]
  )
}
