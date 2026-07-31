"use client"

// Web bridge for plugin deep-links (C2). The browser has no OS `cognia://`
// scheme, so web links use `/deep-link?u=<encoded cognia url>`; this page
// converts the entry to the `cognia://` form and dispatches it to the owning
// plugin's handler (after lazy-activating it). Static-export safe — pure client.

import { useEffect } from "react"
import { useTranslations } from "next-intl"
import { parseDeepLink } from "@/lib/plugin/uri/parse-deep-link"
import { dispatchUri } from "@/lib/plugin/uri/uri-handler-registry"

export default function DeepLinkPage() {
  const t = useTranslations("plugins.deepLink")

  useEffect(() => {
    const raw = new URLSearchParams(window.location.search).get("u")
    if (!raw) return
    const parsed = parseDeepLink(raw)
    if (!parsed) return
    void (async () => {
      try {
        const { getPluginManager } = await import("@/lib/plugin/core/manager")
        await getPluginManager().handleActivationEvent(`onUri:${parsed.pluginId}`)
      } catch {
        // Manager not initialized — a statically-active plugin may still handle it.
      }
      dispatchUri(parsed)
    })()
  }, [])

  return (
    <main className="flex h-screen flex-col items-center justify-center p-6 text-center">
      <p className="text-sm text-muted-foreground">{t("routing")}</p>
    </main>
  )
}
