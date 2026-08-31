"use client"

import dynamic from "next/dynamic"
import { Suspense, useCallback } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { useMessagePermalink } from "@/hooks/chat/use-message-permalink"
import { useCompactLayout } from "@/hooks/ui/use-compact-layout"

// Platform shells are mutually exclusive at runtime but static imports made
// Turbopack compile both multi-thousand-module graphs for `/`. Keep the
// hydration snapshot lightweight, then request only the active shell.
const AppShellMobile = dynamic(
  () => import("@/components/app-shell-mobile").then((module) => module.AppShellMobile),
  { ssr: false }
)
const DesktopChatWorkspace = dynamic(
  () =>
    import("@/components/desktop/desktop-chat-workspace").then(
      (module) => module.DesktopChatWorkspace
    ),
  { ssr: false }
)

/**
 * Consumes `/?session=…&message=…` message permalinks (see
 * `lib/chat/message-permalink.ts`). Renders nothing — it exists so the chat
 * shells stay unaware of routing, and so `useSearchParams` has somewhere to
 * live under the `<Suspense>` boundary that a static export requires.
 */
function MessagePermalinkConsumer() {
  const t = useTranslations("chat.jump")
  const router = useRouter()
  // A link that cannot land is the common case for a shared permalink — the
  // conversation was deleted, the message compacted away, the link came from
  // another device. Silence there is indistinguishable from the app ignoring
  // the click.
  const onUnresolved = useCallback(() => toast.error(t("notFound")), [t])
  // Clear through the router, not `history.replaceState`. `replaceState` does
  // not notify Next, so `useSearchParams` kept returning the consumed link —
  // and pushing the SAME permalink again (terminal → "locate in conversation",
  // pressed twice for one tab) changed nothing the hook could observe, so it
  // re-armed only once per tab. `replace` is still not a history entry.
  const onConsumed = useCallback(() => router.replace("/", { scroll: false }), [router])
  useMessagePermalink({ params: useSearchParams(), onConsumed, onUnresolved })
  return null
}

export default function Home() {
  // Layout, not runtime: a 375px browser window needs the phone shell too,
  // and it used to get the three-pane desktop workspace with no navigation
  // (`GuildRail` is `hidden md:flex`).
  const compact = useCompactLayout()
  return (
    <>
      {/* Static-export idiom (mirrors `/memory?id=`): `useSearchParams` throws
          during prerender unless it sits inside a Suspense boundary. */}
      <Suspense fallback={null}>
        <MessagePermalinkConsumer />
      </Suspense>
      {compact ? <AppShellMobile /> : <DesktopChatWorkspace />}
    </>
  )
}
