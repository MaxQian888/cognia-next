"use client"

// Routes `cognia://plugin/<id>/...` deep-links to the owning plugin's handler
// (C2). Mirrors ConnectorDeepLinkRouter: subscribes to the live Tauri deep-link
// pipe (`onDeepLink`) + reads the cold-start launch URL (`getLaunchDeepLink`).
// For each plugin URL it lazy-activates the plugin (`onUri:<id>` activation)
// then dispatches to its registered handler. No-op outside Tauri.

import { useEffect } from "react"
import { isTauri } from "@/lib/tauri"
import { onDeepLink, getLaunchDeepLink } from "@/lib/tauri/deep-link"
import { safeUnlisten } from "@/lib/tauri/safe-unlisten"
import { parseDeepLink } from "@/lib/plugin/uri/parse-deep-link"
import { dispatchUri } from "@/lib/plugin/uri/uri-handler-registry"

async function routePluginUrl(raw: string): Promise<void> {
  const parsed = parseDeepLink(raw)
  if (!parsed) return
  // Lazy-activate the target plugin if it gated on `onUri:<id>`.
  try {
    const { getPluginManager } = await import("@/lib/plugin/core/manager")
    await getPluginManager().handleActivationEvent(`onUri:${parsed.pluginId}`)
  } catch {
    // Manager not initialized — a statically-active plugin may still handle it.
  }
  dispatchUri(parsed)
}

export function PluginDeepLinkRouter() {
  useEffect(() => {
    if (!isTauri()) return
    let unlisten: (() => void) | null = null
    let cancelled = false

    void (async () => {
      // Cold-start: the URL the app was launched with.
      const launch = await getLaunchDeepLink()
      if (!cancelled && launch) {
        for (const url of launch) void routePluginUrl(url)
      }
      unlisten = await onDeepLink((urls) => {
        for (const url of urls) void routePluginUrl(url)
      })
      if (cancelled && unlisten) {
        safeUnlisten(unlisten)
        unlisten = null
      }
    })()

    return () => {
      cancelled = true
      safeUnlisten(unlisten)
    }
  }, [])

  return null
}

export default PluginDeepLinkRouter
