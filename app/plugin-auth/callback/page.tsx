"use client"

// Web OAuth redirect target for plugin auth providers (C1). When a plugin runs
// a PKCE flow on the web profile (no loopback server), it opens the provider's
// authorize URL with this page as the redirect_uri. On load we forward the
// `code`+`state` back to the originating context via `window.opener` and a
// `BroadcastChannel("plugin-auth")` (the flow's `waitForCode` listens), then
// the window can be closed. Static-export safe — pure client, no server.
//
// The page used to say "Authorization complete" no matter what came back, so a
// user who clicked Deny (or whose provider rejected the request) was told it
// worked while the plugin received an error. The message now follows the
// outcome: success only with a code, the provider's error when there is one,
// and "nothing came back" for a bare visit.

import { useEffect, useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import { CircleAlertIcon, CircleCheckIcon } from "lucide-react"

type CallbackOutcome =
  | { kind: "pending" }
  | { kind: "success" }
  | { kind: "error"; error: string; description: string | null }
  | { kind: "missing" }

const NEVER_CHANGES = () => () => {}
// Static export: the build-time render has no query string. The server
// snapshot is `null` ("not read yet"), so the pre-hydration HTML says
// "Completing sign-in…" rather than asserting an outcome it cannot know.
const readSearch = () => window.location.search
const readServerSearch = (): string | null => null

function outcomeOf(search: string | null): CallbackOutcome {
  if (search === null) return { kind: "pending" }
  const params = new URLSearchParams(search)
  const error = params.get("error")
  if (error) {
    return { kind: "error", error, description: params.get("error_description") }
  }
  if (params.get("code")) return { kind: "success" }
  return { kind: "missing" }
}

export default function PluginAuthCallbackPage() {
  const t = useTranslations("plugins.auth.callback")
  const search = useSyncExternalStore(NEVER_CHANGES, readSearch, readServerSearch)
  const outcome = outcomeOf(search)

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
    <main
      className="flex h-dvh flex-col items-center justify-center gap-2 p-6 text-center"
      data-outcome={outcome.kind}
    >
      {outcome.kind === "error" ? (
        <div role="alert" className="max-w-md space-y-2">
          <CircleAlertIcon className="mx-auto size-6 text-destructive" aria-hidden="true" />
          <p className="text-sm font-medium">{t("failed")}</p>
          <p className="break-words text-xs text-muted-foreground">
            {outcome.description
              ? t("failedDetail", { error: outcome.error, description: outcome.description })
              : t("failedCode", { error: outcome.error })}
          </p>
          <p className="text-xs text-muted-foreground">{t("failedHint")}</p>
        </div>
      ) : outcome.kind === "success" ? (
        <div role="status" className="space-y-2">
          <CircleCheckIcon className="mx-auto size-6 text-primary" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">{t("done")}</p>
        </div>
      ) : outcome.kind === "missing" ? (
        <p role="alert" className="max-w-md text-sm text-muted-foreground">
          {t("missing")}
        </p>
      ) : (
        <p role="status" className="text-sm text-muted-foreground">
          {t("working")}
        </p>
      )}
    </main>
  )
}
