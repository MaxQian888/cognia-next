"use client"

/**
 * Generic toast surface for `plugin:error` CustomEvents fired by every
 * plugin-pipeline step that wants to surface a failure to the user
 * (install / load / enable / disable / uninstall / config / activation /
 * permission-register / wasm-preload / hot-reload / local-install).
 *
 * Distinct from `PluginEnableFailureToaster`, which only handles the
 * narrower `plugin:enable-failed` event fired by `enablePlugin`'s
 * rollback path. The two coexist:
 *   - enablePlugin rollback → PLUGIN_ENABLE_FAILED_EVENT → existing
 *     PluginEnableFailureToaster
 *   - everything else → PLUGIN_ERROR_EVENT → this component
 *
 * Mounted alongside its sibling near the app root in `app/layout.tsx`.
 */

import { useEffect, useRef } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { subscribePluginError, type PluginErrorEventDetail } from "@/lib/plugin/error-bus"

/** Dedupe a `(pluginId, stage, message)` triple within this window (ms). */
const DEDUPE_WINDOW_MS = 2_000

export function PluginErrorToaster() {
  const t = useTranslations("plugins.errors")
  const recentRef = useRef<Map<string, number>>(new Map())

  useEffect(() => {
    return subscribePluginError((detail) => {
      const now = Date.now()
      const key = `${detail.pluginId}::${detail.stage}::${detail.message}`
      const recent = recentRef.current
      for (const [k, ts] of recent) {
        if (now - ts > DEDUPE_WINDOW_MS) recent.delete(k)
      }
      if (recent.has(key)) return
      recent.set(key, now)
      const display = detail.pluginName ?? detail.pluginId
      const title = translateStageTitle(t, detail.stage, display)
      const description = detail.message
      const toastFn = detail.severity === "warning" ? toast.warning : toast.error
      toastFn(title, {
        description,
        id: key,
        duration: detail.recoverable ? 6_000 : 8_000,
      })
    })
  }, [t])

  return null
}

function translateStageTitle(
  t: ReturnType<typeof useTranslations>,
  stage: PluginErrorEventDetail["stage"],
  pluginName: string
): string {
  // next-intl raises on missing keys — but the `stage` set is closed so we
  // can ship one key per stage in both locales and rely on the type checker
  // to keep them in sync.
  const stageKey: Record<PluginErrorEventDetail["stage"], string> = {
    install: "install",
    "install-rollback": "installRollback",
    load: "load",
    enable: "enable",
    disable: "disable",
    uninstall: "uninstall",
    config: "config",
    activation: "activation",
    "permission-register": "permissionRegister",
    "wasm-preload": "wasmPreload",
    "hot-reload": "hotReload",
    "local-install": "localInstall",
    adapter: "adapter",
  }
  return t(stageKey[stage], { pluginName })
}
