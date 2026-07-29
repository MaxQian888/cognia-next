"use client"

import { Suspense, useCallback } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { AppShellMobile } from "@/components/app-shell-mobile"
import { DesktopChatWorkspace } from "@/components/desktop/desktop-chat-workspace"
import { useMessagePermalink } from "@/hooks/chat/use-message-permalink"
import { usePlatform } from "@/hooks/use-platform"

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
  const platform = usePlatform()
  return (
    <>
      {/* Static-export idiom (mirrors `/memory?id=`): `useSearchParams` throws
          during prerender unless it sits inside a Suspense boundary. */}
      <Suspense fallback={null}>
        <MessagePermalinkConsumer />
      </Suspense>
      {platform === "mobile" ? <AppShellMobile /> : <DesktopChatWorkspace />}
    </>
  )
}
