"use client"

/**
 * Toast surface for `plugin:enable-failed` CustomEvents fired by
 * `lib/plugin/core/manager.ts:enablePlugin` when the rollback path
 * runs. The manager can't reach `useTranslations()` from .ts code, so
 * this component owns the translation + render.
 *
 * Pattern mirrors `PluginConsentOverlay` — listens on `window`, holds
 * no state of its own beyond a small dedupe set so a noisy retry
 * loop doesn't spam the toaster. Mounted once near the app root in
 * `app/layout.tsx` alongside `<PluginConsentOverlay />`.
 */

import { useEffect, useRef } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

// Leaf imports only: this toaster is mounted in the root layout, and the
// plugin manager must stay out of the first-paint module graph.
import { pluginDetailHref, pluginEnableFailureToastId } from "@/hooks/plugins/plugin-links"
import { usePluginErrorMessage } from "@/hooks/plugins/use-plugin-error-message"

import {
  PLUGIN_ENABLE_FAILED_EVENT,
  type PluginEnableFailedEventDetail,
} from "@/lib/plugin/error-bus"

/** Dedupe a (pluginId, errorMessage) pair within this window (ms). */
const DEDUPE_WINDOW_MS = 2_000

export function PluginEnableFailureToaster() {
  const t = useTranslations("plugins.enableFailure")
  const tLifecycle = useTranslations("plugins.lifecycleFeedback")
  const describe = usePluginErrorMessage()
  const router = useRouter()
  // Each entry: key -> timestamp the toast was fired. We swap a Map
  // through a ref so the listener identity stays stable across renders.
  const recentRef = useRef<Map<string, number>>(new Map())

  useEffect(() => {
    if (typeof window === "undefined") return
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<PluginEnableFailedEventDetail>).detail
      if (!detail || !detail.pluginId) return
      const now = Date.now()
      const key = `${detail.pluginId}::${detail.errorMessage}`
      const recent = recentRef.current
      // Prune anything older than the window so the Map doesn't grow
      // unboundedly under a flapping plugin.
      for (const [k, ts] of recent) {
        if (now - ts > DEDUPE_WINDOW_MS) recent.delete(k)
      }
      if (recent.has(key)) return
      recent.set(key, now)
      toast.error(t("title", { pluginName: detail.pluginName }), {
        // The manager's message is English; the known shapes are localized.
        description: t("description", {
          pluginName: detail.pluginName,
          errorMessage: describe(detail.errorMessage),
        }),
        // Same id the panel's own enable feedback uses for this failure, so
        // the two reports collapse into one toast.
        id: pluginEnableFailureToastId(detail.pluginId, detail.errorMessage),
        action: {
          label: tLifecycle("viewDetails"),
          onClick: () => router.push(pluginDetailHref(detail.pluginId)),
        },
      })
    }
    window.addEventListener(PLUGIN_ENABLE_FAILED_EVENT, handler)
    return () => window.removeEventListener(PLUGIN_ENABLE_FAILED_EVENT, handler)
  }, [t, tLifecycle, describe, router])

  return null
}
