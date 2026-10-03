"use client"

// Web bridge for plugin deep-links (C2). The browser has no OS `cognia://`
// scheme, so web links use `/deep-link?u=<encoded cognia url>`; this page
// converts the entry to the `cognia://` form and dispatches it to the owning
// plugin's handler (after lazy-activating it). Static-export safe — pure client.

import { useEffect } from "react"
import { useTranslations } from "next-intl"
import { routePluginDeepLink } from "@/lib/plugin/uri/route-deep-link"

export default function DeepLinkPage() {
  const t = useTranslations("plugins.deepLink")

  useEffect(() => {
    const raw = new URLSearchParams(window.location.search).get("u")
    if (!raw) return
    void routePluginDeepLink(raw)
  }, [])

  return (
    <main className="flex h-screen flex-col items-center justify-center p-6 text-center">
      <p className="text-sm text-muted-foreground">{t("routing")}</p>
    </main>
  )
}
