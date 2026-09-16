"use client"

import { Suspense, useCallback } from "react"
import { useRouter, useSearchParams } from "next/navigation"

import { BotConsole } from "@/components/bots/bot-console"
import { BotsMobileBody } from "@/components/mobile/bots/bots-mobile-body"
import { useCompactLayout } from "@/hooks/ui/use-compact-layout"

/**
 * `/bots`, the Bot control plane's console.
 *
 * Thin by design: the route owns nothing but the deep link. Selection lives in
 * `?bot=` rather than a dynamic `[id]` segment, which breaks in the production
 * Tauri static export, and `useSearchParams()` throws during the static
 * prerender unless a Suspense boundary lets it bail out to client rendering.
 *
 * `?install=1` opens the install sheet, the same hand-off shape `/devices`
 * uses for `?addHost=1`.
 *
 * The compact branch is not a smaller console but an inverted one, exactly
 * like `/devices`: on a phone the Bot list IS the page and the detail
 * arrives as a drawer, where `FeaturePageShell` would have put the list
 * behind a Sheet trigger — and because `?bot=` IS the selection, a deep link
 * on a phone opens the detail drawer directly.
 */
function BotsRoute() {
  const router = useRouter()
  const params = useSearchParams()
  const compact = useCompactLayout()
  const selectedId = params.get("bot") ?? undefined

  const select = useCallback(
    (installationId: string) => {
      const next = new URLSearchParams(params.toString())
      next.set("bot", installationId)
      // `?install=1` is consumed by opening the sheet. Leaving it in the URL
      // would reopen it on the next navigation back to this route.
      next.delete("install")
      router.replace(`/bots?${next.toString()}`)
    },
    [params, router]
  )

  const deselect = useCallback(() => {
    const next = new URLSearchParams(params.toString())
    next.delete("bot")
    const query = next.toString()
    router.replace(query ? `/bots?${query}` : "/bots")
  }, [params, router])

  const bodyProps = {
    selectedId,
    onSelect: select,
    onDeselect: deselect,
    installParam: params.get("install"),
  }

  return compact ? <BotsMobileBody {...bodyProps} /> : <BotConsole {...bodyProps} />
}

export default function BotsPage() {
  return (
    <Suspense fallback={null}>
      <BotsRoute />
    </Suspense>
  )
}
