"use client"

import { Suspense, useCallback } from "react"
import { useRouter, useSearchParams } from "next/navigation"

import { BotConsole } from "@/components/bots/bot-console"

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
 * No compact branch yet, unlike `/devices`. `FeaturePageShell` already folds
 * its rail into a Sheet below `lg`, and a phone cannot drain a Bot queue on
 * its own, so an inverted list-first body would be answering a question the
 * mobile shell does not yet get to ask.
 */
function BotsRoute() {
  const router = useRouter()
  const params = useSearchParams()
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

  return (
    <BotConsole
      selectedId={selectedId}
      onSelect={select}
      onDeselect={deselect}
      installParam={params.get("install")}
    />
  )
}

export default function BotsPage() {
  return (
    <Suspense fallback={null}>
      <BotsRoute />
    </Suspense>
  )
}
