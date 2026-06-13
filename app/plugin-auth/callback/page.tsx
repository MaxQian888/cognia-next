"use client"

// Web OAuth redirect target for plugin auth providers (C1). When a plugin runs
// a PKCE flow on the web profile (no loopback server), it opens the provider's
// authorize URL with this page as the redirect_uri. On load we forward the
// `code`+`state` back to the originating context via `window.opener` and a
// `BroadcastChannel("plugin-auth")` (the flow's `waitForCode` listens), then
// the window can be closed. Static-export safe — pure client, no server.

import { useEffect } from "react"
import { useTranslations } from "next-intl"

export default function PluginAuthCallbackPage() {
  const t = useTranslations("plugins.auth.callback")

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const code = params.get("code")
    const state = params.get("state")
    const error = params.get("error")
    const payload = { __pluginAuth: true as const, code, state, error }

    try {
      window.opener?.postMessage(payload, window.location.origin)
    } catch {
      // opener may be cross-origin / absent — the channel is the fallback.
    }
    try {
      const channel = new BroadcastChannel("plugin-auth")
      channel.postMessage(payload)
      channel.close()
    } catch {
      // BroadcastChannel unsupported — opener postMessage already attempted.
    }
  }, [])

  return (
    <main className="flex h-screen flex-col items-center justify-center gap-2 p-6 text-center">
      <p className="text-sm text-muted-foreground">{t("done")}</p>
    </main>
  )
}
